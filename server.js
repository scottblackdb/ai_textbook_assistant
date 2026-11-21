// Course Companion server: serves the static UI and exposes POST /api/chat,
// which routes to one of two modes:
//   genie  - Databricks Genie agent over the course PDFs   (lib/genie.js)
//   vector - Lakebase pgvector search + gpt-6-luna          (lib/rag.js)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');

loadDotEnv(join(ROOT, '.env')); // must run before the lib/* modules read process.env
const { chat: genieChat } = await import('./lib/genie.js');

const PORT = Number(process.env.PORT || 3000);
const MAX_MESSAGE_CHARS = 2000;
// Model shown in the UI for vector mode; same default as lib/rag.js.
const VECTOR_MODEL = process.env.RAG_CHAT_ENDPOINT || 'databricks-gpt-6-luna';

// rag.js (and its `pg` dependency) loads lazily, so a missing `npm install`
// only disables vector mode instead of crashing the server.
let ragPromise = null;
async function vectorChat(...args) {
  ragPromise ||= import('./lib/rag.js').catch(err => { ragPromise = null; throw err; });
  return (await ragPromise).chat(...args);
}
const MODES = { genie: genieChat, vector: vectorChat };

function loadDotEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m || line.trim().startsWith('#') || m[1] in process.env) continue;
      let value = m[2];
      const quoted = value.match(/^(["'])(.*)\1$/);
      if (quoted) value = quoted[2];
      else value = value.replace(/\s+#.*$/, ''); // strip inline comments on unquoted values
      process.env[m[1]] = value;
    }
  } catch { /* no .env file, fine */ }
}

// ---- Chat endpoint --------------------------------------------------------
async function handleChat(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
  const message = String(payload.message || '').trim();
  if (!message) return json(res, 400, { error: 'Message is required' });
  if (message.length > MAX_MESSAGE_CHARS) return json(res, 400, { error: `Message too long (max ${MAX_MESSAGE_CHARS} characters)` });
  const mode = payload.mode || 'genie';
  if (!Object.hasOwn(MODES, mode)) return json(res, 400, { error: 'Unknown mode' });
  const conversationId = typeof payload.conversationId === 'string' && /^[\w-]+$/.test(payload.conversationId)
    ? payload.conversationId : undefined;
  const history = Array.isArray(payload.history) ? payload.history : [];

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  const send = obj => res.write(JSON.stringify(obj) + '\n');

  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const timeout = setTimeout(() => abort.abort(new Error('timeout')), 5 * 60_000);

  try {
    await MODES[mode]({ message, conversationId, history }, send, abort.signal);
  } catch (err) {
    if (!abort.signal.aborted || err?.message === 'timeout') {
      console.error(`Chat error (${mode}):`, err);
      send({ type: 'error', message: err?.message === 'timeout'
        ? 'That took too long. Please try a narrower question.'
        : err?.code === 'ERR_MODULE_NOT_FOUND'
          ? 'This mode is not available on the server right now.'
          : 'Could not reach the assistant. Please try again.' });
    }
  } finally {
    clearTimeout(timeout);
    res.end();
  }
}

// ---- HTTP plumbing --------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.json': 'application/json',
};

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolveBody, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^([/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + '/')) return json(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
};

http.createServer((req, res) => {
  for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
  if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
  if (req.method === 'GET' && req.url === '/api/config') return json(res, 200, { vectorModel: VECTOR_MODEL });
  if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true });
  if (req.method === 'GET') return serveStatic(req, res);
  json(res, 405, { error: 'Method not allowed' });
}).listen(PORT, () => console.log(`Textbook assistant running at http://localhost:${PORT}`));
