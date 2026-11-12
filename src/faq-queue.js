const crypto = require('node:crypto');
const { db } = require('./database');
const { getFaqIndexStatus } = require('./data-tools');
const QUEUE_NAME = 'zaykaa-background';
const INDEX_JOB = 'index-faq-documents';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
let queueResources;

async function getQueueResources() {
  if (queueResources) return queueResources;
  const [{ Queue }, RedisModule] = await Promise.all([import('bullmq'), import('ioredis')]);
  const Redis = RedisModule.default || RedisModule.Redis;
  const connection = new Redis(REDIS_URL, {
    connectTimeout: 3000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  await connection.connect();
  const queue = new Queue(QUEUE_NAME, { connection });
  queueResources = { queue, connection };
  return queueResources;
}

async function enqueueFaqIndex() {
  const status = getFaqIndexStatus();
  if (status.ready) return { queued: false, status: 'ready' };
  const rows = db.prepare('SELECT id, question, answer FROM faq_documents ORDER BY id').all();
  const revision = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 12);
  const model = status.model.replace(/[^a-z0-9_-]/gi, '-');
  const jobId = `faq-index-${model}-${revision}`;
  const { queue } = await getQueueResources();
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== 'completed' && state !== 'failed') return { queued: false, status: state, jobId };
    await existing.remove();
  }
  await queue.add(INDEX_JOB, { revision, model: status.model }, {
    jobId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1500 },
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: true,
  });
  return { queued: true, status: 'waiting', jobId };
}

async function closeFaqQueue() {
  if (!queueResources) return;
  const { queue, connection } = queueResources;
  queueResources = undefined;
  await queue.close();
  if (connection.status !== 'end') await connection.quit();
}
module.exports = { QUEUE_NAME, INDEX_JOB, enqueueFaqIndex, closeFaqQueue };
