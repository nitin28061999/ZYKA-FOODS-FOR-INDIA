const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleMessage, closeOrchestrator } = require('./src/agents');
const { enqueueFaqIndex, closeFaqQueue } = require('./src/faq-queue');
const { getFaqIndexStatus } = require('./src/data-tools');

const root = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 3000);
const allowedOrigins = new Set([
  'http://localhost:' + port,
  'http://127.0.0.1:' + port,
  ...(process.env.CORS_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean),
]);
const apiPolicies = {
  '/api/chat': { methods: ['POST'], headers: ['content-type'] },
  '/api/health': { methods: ['GET'], headers: ['content-type'] },
};
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const maxBodyBytes = 16 * 1024;

function applyApiCors(req, res, pathname) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Vary', 'Origin');
    if (!allowedOrigins.has(origin)) return { status: 403, error: 'This origin is not allowed to access the API.' };
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  if (req.method !== 'OPTIONS') return null;

  res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  const policy = apiPolicies[pathname];
  if (!policy) return { status: 404, error: 'API route not found.' };
  const requestedMethod = (req.headers['access-control-request-method'] || '').toUpperCase();
  const requestedHeaders = (req.headers['access-control-request-headers'] || '').split(',').map(header => header.trim().toLowerCase()).filter(Boolean);
  if ((requestedMethod && !policy.methods.includes(requestedMethod)) || requestedHeaders.some(header => !policy.headers.includes(header))) {
    return { status: 403, error: 'This preflight request is not allowed.' };
  }
  res.setHeader('Access-Control-Allow-Methods', [...policy.methods, 'OPTIONS'].join(', '));
  if (policy.headers.length) res.setHeader('Access-Control-Allow-Headers', policy.headers.join(', '));
  res.setHeader('Access-Control-Max-Age', '600');
  res.writeHead(204);
  res.end();
  return { handled: true };
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch { return sendJson(res, 400, { error: 'Invalid URL.' }); }

  if (url.pathname.startsWith('/api/')) {
    const cors = applyApiCors(req, res, url.pathname);
    if (cors?.handled) return;
    if (cors) return sendJson(res, cors.status, { error: cors.error });
  }

  if (url.pathname === '/api/health') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS');
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }
    try {
      return sendJson(res, 200, { status: 'ok', database: 'connected', faqIndex: getFaqIndexStatus() });
    } catch (error) {
      console.error('Health check failed:', error);
      return sendJson(res, 503, { status: 'error', database: 'unavailable' });
    }
  }

  if (url.pathname === '/api/chat') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }
    const contentType = (req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') return sendJson(res, 415, { error: 'Content-Type must be application/json.' });
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      req.resume();
      return sendJson(res, 413, { error: 'Message is too large. Keep it under 16 KB.' });
    }
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      if (Buffer.byteLength(body) + chunk.length > maxBodyBytes) tooLarge = true;
      else if (!tooLarge) body += chunk;
    });
    req.on('end', async () => {
      if (tooLarge) return sendJson(res, 413, { error: 'Message is too large. Keep it under 16 KB.' });
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch { return sendJson(res, 400, { error: 'I couldn’t read that message. Please try again.' }); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return sendJson(res, 400, { error: 'Request body must be a JSON object.' });
      }
      const { message, threadId } = payload;
      if (typeof message !== 'string' || !message.trim()) return sendJson(res, 400, { error: 'Type a message to get started.' });
      if (message.length > 4000) return sendJson(res, 413, { error: 'Message is too long. Keep it under 4,000 characters.' });
      if (typeof threadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId)) {
        return sendJson(res, 400, { error: 'Refresh the page to start a new chat.' });
      }
      if (!process.env.OPENAI_API_KEY) return sendJson(res, 503, { error: 'Add your OpenAI key to .env, then restart Zaykaa to enable the AI agents.' });
      try {
        const result = await handleMessage(message.trim(), threadId);
        sendJson(res, 200, result);
      } catch (error) {
        console.error('LangChain/MCP request failed:', error);
        sendJson(res, 502, { error: 'The assistant could not complete that request. Please try again.' });
      }
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'API route not found.' });
  let relative;
  try { relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)); }
  catch { return sendJson(res, 400, { error: 'Invalid URL path.' }); }
  const file = path.resolve(root, relative);
  const relativeFile = path.relative(root, file);
  if (relativeFile === '..' || relativeFile.startsWith('..' + path.sep) || path.isAbsolute(relativeFile)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.on('error', error => {
  console.error('HTTP server failed:', error.message);
  process.exitCode = 1;
});
function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
server.listen(port, '127.0.0.1', () => {
  const actualPort = server.address().port;
  console.log('Zaykaa is running at http://localhost:' + actualPort);
  if (process.env.OPENAI_API_KEY) {
    enqueueFaqIndex().then(result => console.log('FAQ indexing queue: ' + result.status))
      .catch(error => console.warn('FAQ indexing was not queued (start Redis with docker compose up -d): ' + error.message));
  }
});

let shutdownPromise;
async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    await new Promise(resolve => server.close(resolve));
    await closeOrchestrator();
    await closeFaqQueue();
  })();
  return shutdownPromise;
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void shutdown().finally(() => process.exit(0)); });
}
