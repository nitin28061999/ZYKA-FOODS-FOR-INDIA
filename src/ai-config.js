const PROVIDERS = new Set(['google', 'openai']);

function getAIConfig() {
  const provider = (process.env.AI_PROVIDER || 'google').trim().toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error('AI_PROVIDER must be google or openai.');

  if (provider === 'google') {
    const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
    const googleKey = (process.env.GOOGLE_API_KEY || '').trim();
    const embeddingModel = process.env.GOOGLE_EMBEDDING_MODEL || 'gemini-embedding-001';
    return {
      provider,
      apiKey: geminiKey || googleKey,
      apiKeyName: geminiKey ? 'GEMINI_API_KEY' : googleKey ? 'GOOGLE_API_KEY' : 'GEMINI_API_KEY',
      chatModel: process.env.GOOGLE_MODEL || 'gemini-3.8-flash',
      embeddingModel,
      embeddingIndexModel: provider + ':' + embeddingModel,
    };
  }

  const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
  return {
    provider,
    apiKey: (process.env.OPENAI_API_KEY || '').trim(),
    apiKeyName: 'OPENAI_API_KEY',
    chatModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    embeddingModel,
    embeddingIndexModel: provider + ':' + embeddingModel,
  };
}

module.exports = { getAIConfig };
