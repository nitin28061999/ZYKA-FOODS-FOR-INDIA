const assert = require('node:assert/strict');
const { test } = require('node:test');
const envKeys = ['AI_PROVIDER', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_MODEL', 'GOOGLE_EMBEDDING_MODEL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_EMBEDDING_MODEL'];

function withEnv(values, callback) {
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) {
    if (Object.hasOwn(values, key)) process.env[key] = values[key];
    else delete process.env[key];
  }
  try { return callback(); }
  finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('AI provider defaults to Gemini and reads its key, model, and embedding settings', () => {
  const { getAIConfig } = require('../src/ai-config');
  withEnv({ GEMINI_API_KEY: 'gemini-secret' }, () => {
    assert.deepEqual(getAIConfig(), {
      provider: 'google',
      apiKey: 'gemini-secret',
      apiKeyName: 'GEMINI_API_KEY',
      chatModel: 'gemini-3.8-flash',
      embeddingModel: 'gemini-embedding-001',
      embeddingIndexModel: 'google:gemini-embedding-001',
    });
  });
});

test('Gemini is identified as the missing key when no provider key is configured', () => {
  const { getAIConfig } = require('../src/ai-config');
  withEnv({}, () => assert.equal(getAIConfig().apiKeyName, 'GEMINI_API_KEY'));
});

test('AI provider accepts Google’s GOOGLE_API_KEY alias', () => {
  const { getAIConfig } = require('../src/ai-config');
  withEnv({ GOOGLE_API_KEY: 'google-secret' }, () => {
    assert.equal(getAIConfig().apiKey, 'google-secret');
    assert.equal(getAIConfig().apiKeyName, 'GOOGLE_API_KEY');
  });
});

test('OpenAI remains selectable with provider-specific models and key', () => {
  const { getAIConfig } = require('../src/ai-config');
  withEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'openai-secret' }, () => {
    assert.deepEqual(getAIConfig(), {
      provider: 'openai',
      apiKey: 'openai-secret',
      apiKeyName: 'OPENAI_API_KEY',
      chatModel: 'gpt-4.1-mini',
      embeddingModel: 'text-embedding-3-small',
      embeddingIndexModel: 'openai:text-embedding-3-small',
    });
  });
});

test('unsupported AI providers produce a clear configuration error', () => {
  const { getAIConfig } = require('../src/ai-config');
  withEnv({ AI_PROVIDER: 'unknown' }, () => assert.throws(getAIConfig, /AI_PROVIDER must be google or openai/i));
});
