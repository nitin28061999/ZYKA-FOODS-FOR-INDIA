const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { db } = require('../src/database');
const { getAIConfig } = require('../src/ai-config');
const { getFaqIndexStatus, lookupOrder, searchFaq, searchMenu } = require('../src/data-tools');

const projectRoot = path.resolve(__dirname, '..');
let child;
let origin;
let childOutput = '';

before(async () => {
  const port = 0;
  child = spawn(process.execPath, ['--env-file-if-exists=.env', 'server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), AI_PROVIDER: 'google', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENAI_API_KEY: '', CORS_ORIGINS: 'http://localhost:5173' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', chunk => { childOutput += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server failed to start. Output: ${childOutput}`)), 8000);
    child.stdout.on('data', chunk => {
      childOutput += chunk.toString();
      const match = childOutput.match(/http:\/\/localhost:(\d+)/);
      if (match) {
        origin = `http://127.0.0.1:${match[1]}`;
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Server exited with code ${code}. Output: ${childOutput}`));
    });
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
});

test('order lookup accepts normalized IDs and reports missing records', () => {
  assert.equal(lookupOrder('zy 2048').id, 'ZY-2048');
  assert.deepEqual(lookupOrder('ZY-9999'), { notFound: true, orderId: 'ZY-9999' });
});

test('data tools reject empty or non-string search inputs clearly', async () => {
  await assert.rejects(searchFaq('  '), /non-empty string/i);
  assert.throws(() => searchMenu(null), /non-empty string/i);
  assert.throws(() => lookupOrder(''), /non-empty string/i);
});

test('FAQ keyword retrieval ranks the matching policy without calling embeddings', async () => {
  const priorKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const result = await searchFaq('payment methods UPI cards');
    assert.equal(result.mode, 'bm25');
    assert.equal(result.hits[0].id, 'payment-methods');
    assert.deepEqual((await searchFaq('zzzxqv unrelated topic')).hits, []);
  } finally {
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  }
});

test('menu search returns relevant matches and no unrelated fallback dishes', () => {
  const vegetarian = searchMenu('vegetarian');
  assert.ok(vegetarian.length > 0);
  assert.ok(vegetarian.every(item => item.tags.includes('vegetarian')));
  assert.deepEqual(searchMenu('zzzxqv unmatched dish'), []);
});

test('FAQ indexing status rejects malformed stored vectors', () => {
  db.exec('BEGIN');
  try {
    const id = db.prepare('SELECT id FROM faq_documents LIMIT 1').get().id;
    db.prepare('UPDATE faq_documents SET embedding_model = ?, embedding_dimensions = 2, embedding_json = ? WHERE id = ?')
      .run(getAIConfig().embeddingIndexModel, '[1]', id);
    assert.equal(getFaqIndexStatus().ready, false);
  } finally {
    db.exec('ROLLBACK');
  }
});

test('health endpoint allows configured frontend origins', async () => {
  const response = await fetch(`${origin}/api/health`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.match(response.headers.get('vary'), /Origin/i);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.ok(body.faqIndex.total > 0);
});

test('chat preflight allows only the configured origin, POST, and content-type', async () => {
  const allowed = await fetch(`${origin}/api/chat`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.match(allowed.headers.get('vary'), /Access-Control-Request-Headers/i);

  const disallowed = await fetch(`${origin}/api/chat`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://malicious.example', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(disallowed.status, 403);
  assert.equal(disallowed.headers.get('access-control-allow-origin'), null);

  const unsafeHeader = await fetch(`${origin}/api/chat`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
  });
  assert.equal(unsafeHeader.status, 403);
});

test('health preflight supports GET and disallows other methods', async () => {
  const allowed = await fetch(`${origin}/api/health`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET' },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.match(allowed.headers.get('access-control-allow-methods'), /GET/);

  const disallowed = await fetch(`${origin}/api/health`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'DELETE' },
  });
  assert.equal(disallowed.status, 403);
});

test('chat API validates content type, JSON shape, and request size', async () => {
  const wrongType = await fetch(`${origin}/api/chat`, { method: 'POST', body: 'message=hi' });
  assert.equal(wrongType.status, 415);

  const nullPayload = await fetch(`${origin}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null',
  });
  assert.equal(nullPayload.status, 400);
  assert.match((await nullPayload.json()).error, /JSON object/);

  const invalidId = await fetch(`${origin}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hi', threadId: '------------------------------------' }),
  });
  assert.equal(invalidId.status, 400);

  const validRequestWithoutKey = await fetch(`${origin}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello', threadId: '8c0f28ec-d6a4-4bd6-ae90-9759fbe28b82' }),
  });
  assert.equal(validRequestWithoutKey.status, 503);

  const oversized = await fetch(`${origin}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(17 * 1024) }),
  });
  assert.equal(oversized.status, 413);
});

test('static paths cannot escape the public folder', async () => {
  const response = await fetch(`${origin}/..%2Fserver.js`);
  assert.equal(response.status, 403);
});
