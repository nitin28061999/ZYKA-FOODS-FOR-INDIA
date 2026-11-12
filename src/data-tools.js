const { db } = require('./database');
const { getAIConfig } = require('./ai-config');

function requireNonEmptyText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  return value.trim();
}

const stop = new Set(['the','a','an','is','are','do','i','you','my','to','for','of','and','can','how','what','with','me','does','have','get','please','could','would','should','this','that','it','in','on','at','from']);
function terms(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(token => token.length > 1 && !stop.has(token));
}
function documentText(doc) { return `Question: ${doc.question}\nAnswer: ${doc.answer}`; }
const embeddingModel = () => getAIConfig().embeddingIndexModel;

let embeddingsPromise;
function getEmbeddings() {
  if (!embeddingsPromise) {
    const config = getAIConfig();
    if (config.provider === 'google') {
      embeddingsPromise = import('@langchain/google-genai').then(({ GoogleGenerativeAIEmbeddings }) =>
        new GoogleGenerativeAIEmbeddings({ model: config.embeddingModel, apiKey: config.apiKey }));
    } else {
      embeddingsPromise = import('@langchain/openai').then(({ OpenAIEmbeddings }) =>
        new OpenAIEmbeddings({ model: config.embeddingModel, apiKey: config.apiKey }));
    }
  }
  return embeddingsPromise;
}
function readVector(value) {
  try {
    const vector = JSON.parse(value || 'null');
    return Array.isArray(vector) && vector.length && vector.every(Number.isFinite) ? vector : null;
  } catch { return null; }
}
function getFaqIndexStatus() {
  const rows = db.prepare('SELECT embedding_model, embedding_dimensions, embedding_json FROM faq_documents').all();
  const modelName = embeddingModel();
  const indexed = rows.filter(row => {
    if (row.embedding_model !== modelName) return false;
    const vector = readVector(row.embedding_json);
    return Boolean(vector && vector.length === Number(row.embedding_dimensions));
  }).length;
  const total = rows.length;
  return { ready: total > 0 && indexed === total, total, indexed, model: modelName };
}
async function indexFaqDocuments() {
  const config = getAIConfig();
  if (!config.apiKey) throw new Error(config.apiKeyName + ' is required to build the FAQ embedding index.');
  const modelName = config.embeddingIndexModel;
  const rows = db.prepare('SELECT id, question, answer, embedding_model, embedding_dimensions, embedding_json FROM faq_documents ORDER BY id').all();
  const missing = rows.filter(row => {
    const vector = readVector(row.embedding_json);
    return row.embedding_model !== modelName || !vector || vector.length !== row.embedding_dimensions;
  });
  if (!missing.length) return getFaqIndexStatus();
  const embeddings = await getEmbeddings();
  const vectors = await embeddings.embedDocuments(missing.map(documentText));
  if (!Array.isArray(vectors) || vectors.length !== missing.length) {
    throw new Error('Embedding provider returned an unexpected number of FAQ vectors.');
  }
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every(Number.isFinite)) {
      throw new Error('Embedding provider returned an invalid FAQ vector.');
    }
  }
  const save = db.prepare('UPDATE faq_documents SET embedding_model = ?, embedding_dimensions = ?, embedding_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    missing.forEach((row, index) => save.run(modelName, vectors[index].length, JSON.stringify(vectors[index]), row.id));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getFaqIndexStatus();
}
function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return 0;
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i]; leftNorm += left[i] ** 2; rightNorm += right[i] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
function bm25Scores(query, bodies) {
  const queryTerms = [...new Set(terms(query))];
  const tokenized = bodies.map(terms);
  const averageLength = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(tokenized.length, 1);
  const documentFrequency = new Map();
  const frequenciesByDocument = tokenized.map(tokens => {
    const frequencies = new Map();
    tokens.forEach(token => frequencies.set(token, (frequencies.get(token) || 0) + 1));
    for (const term of frequencies.keys()) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    return frequencies;
  });
  const k1 = 1.5, b = 0.75;
  return tokenized.map((tokens, index) => {
    const frequencies = frequenciesByDocument[index];
    let score = 0;
    for (const term of queryTerms) {
      const frequency = frequencies.get(term) || 0;
      if (!frequency) continue;
      const docFrequency = documentFrequency.get(term) || 0;
      const inverseDocumentFrequency = Math.log(1 + (tokenized.length - docFrequency + 0.5) / (docFrequency + 0.5));
      score += inverseDocumentFrequency * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * tokens.length / Math.max(averageLength, 1)));
    }
    return score;
  });
}
async function searchFaq(question) {
  question = requireNonEmptyText(question, 'question');
  const modelName = embeddingModel();
  const docs = db.prepare('SELECT id, question, answer, embedding_model, embedding_json FROM faq_documents ORDER BY id').all();
  if (!docs.length) return { mode: 'bm25', indexed: false, hits: [] };
  const lexical = bm25Scores(question, docs.map(documentText));
  const maxLexical = Math.max(...lexical, 0);
  const vectors = docs.map(doc => doc.embedding_model === modelName ? readVector(doc.embedding_json) : null);
  const ready = vectors.every(Boolean);
  let queryVector = null;
  if (ready && getAIConfig().apiKey) queryVector = await (await getEmbeddings()).embedQuery(question);
  const ranked = docs.map((doc, index) => {
    const bm25 = lexical[index];
    const cosine = queryVector ? cosineSimilarity(queryVector, vectors[index]) : null;
    const lexicalNormalized = maxLexical ? bm25 / maxLexical : 0;
    const score = cosine === null ? lexicalNormalized : 0.75 * cosine + 0.25 * lexicalNormalized;
    return { id: doc.id, question: doc.question, answer: doc.answer, score, cosine, bm25 };
  }).sort((a, b) => b.score - a.score);
  const hits = ranked.filter(hit => hit.cosine === null ? hit.bm25 > 0 : hit.cosine >= 0.32 || hit.bm25 > 0).slice(0, 3)
    .map(({ score, cosine, bm25, ...hit }) => ({ ...hit, score: Number(score.toFixed(4)), ...(cosine === null ? {} : { cosine: Number(cosine.toFixed(4)) }), bm25: Number(bm25.toFixed(4)) }));
  return { mode: queryVector ? 'hybrid' : 'bm25', indexed: ready, hits };
}
function lookupOrder(orderId) {
  orderId = requireNonEmptyText(orderId, 'orderId');
  const id = orderId.replace(/[\s-]/g, '').toUpperCase().replace(/^ZY/, 'ZY-');
  const row = db.prepare('SELECT id, items, status, eta, total FROM orders WHERE id = ?').get(id);
  return row || { notFound: true, orderId: id };
}
function searchMenu(query) {
  query = requireNonEmptyText(query, 'query');
  const products = db.prepare('SELECT id, name, category, description, price, tags FROM products').all();
  const scores = bm25Scores(query, products.map(product => `${product.name} ${product.category} ${product.description} ${product.tags}`));
  const maxScore = Math.max(...scores, 0);
  const ranked = products.map((product, index) => ({ ...product, score: scores[index] }))
    .sort((a, b) => b.score - a.score || a.price - b.price);
  const selected = ranked.filter(item => item.score > 0);
  return selected.slice(0, 4).map(({ score, ...item }) => item);
}
module.exports = { searchFaq, lookupOrder, searchMenu, getFaqIndexStatus, indexFaqDocuments };
