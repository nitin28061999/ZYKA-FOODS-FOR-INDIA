const { indexFaqDocuments } = require('./data-tools');
const { QUEUE_NAME, INDEX_JOB } = require('./faq-queue');

async function main() {
  const [{ Worker }, RedisModule] = await Promise.all([import('bullmq'), import('ioredis')]);
  const Redis = RedisModule.default || RedisModule.Redis;
  const connection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
  const worker = new Worker(QUEUE_NAME, async job => {
    if (job.name !== INDEX_JOB) throw new Error(`Unknown background job: ${job.name}`);
    console.log(`Building FAQ vector index (${job.data.model}, revision ${job.data.revision})`);
    const status = await indexFaqDocuments();
    if (!status.ready) throw new Error(`FAQ index incomplete: ${status.indexed}/${status.total}`);
    return status;
  }, { connection, concurrency: 1 });

  worker.on('completed', (job, result) => console.log(`FAQ index job ${job.id} completed (${result.indexed}/${result.total} documents)`));
  worker.on('failed', (job, error) => console.error(`Background job ${job?.id || 'unknown'} failed:`, error.message));
  worker.on('error', error => console.error('Redis worker error:', error.message));
  await worker.waitUntilReady();
  console.log(`Zaykaa worker is listening on ${QUEUE_NAME} at ${process.env.REDIS_URL || 'redis://127.0.0.1:6379'}`);

  let stopping;
  async function shutdown() {
    if (stopping) return stopping;
    stopping = (async () => { await worker.close(); await connection.quit(); })();
    return stopping;
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown().finally(() => process.exit(0)); });
}
main().catch(error => {
  console.error('Zaykaa worker could not start:', error);
  process.exitCode = 1;
});
