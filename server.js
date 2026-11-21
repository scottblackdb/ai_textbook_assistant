// Textbook assistant server.
// Zero dependencies: serves the static UI and proxies chat requests to a
// Databricks Genie agent (Agent mode API), which searches the course PDFs.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');

// ---- Configuration --------------------------------------------------------
loadDotEnv(join(ROOT, '.env'));
const PORT = Number(process.env.PORT || 3000);
const SPACE_ID = process.env.GENIE_SPACE_ID || '01f1e49951b91151bc1e88b97cc6517a';
const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE || 'DEFAULT';
const MAX_MESSAGE_CHARS = 2000;

function loadDotEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* no .env file, fine */ }
}

// ---- Databricks auth ------------------------------------------------------
// Deployed (Databricks Apps / env): DATABRICKS_HOST + DATABRICKS_TOKEN.
// Local dev: host from ~/.databrickscfg, short-lived OAuth token from the CLI.
function hostFromCfg(profile) {
  const cfg = readFileSync(process.env.DATABRICKS_CONFIG_FILE || join(homedir(), '.databrickscfg'), 'utf8');
  let current = null;
  for (const raw of cfg.split('\n')) {
    const line = raw.trim();
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { current = sec[1]; continue; }
    const kv = line.match(/^host\s*=\s*(.+)$/);
    if (kv && current === profile) return kv[1].trim();
  }
  throw new Error(`No host found for profile "${profile}" in ~/.databrickscfg`);
}

function normalizeHost(h) {
  const url = h.startsWith('http') ? h : `https://${h}`;
  return url.replace(/\/+$/, '');
}

let cachedToken = null; // { token, expiresAt }
async function getAuth() {
  if (process.env.DATABRICKS_HOST && process.env.DATABRICKS_TOKEN) {
    return { host: normalizeHost(process.env.DATABRICKS_HOST), token: process.env.DATABRICKS_TOKEN };
  }
  const host = normalizeHost(process.env.DATABRICKS_HOST || hostFromCfg(PROFILE));
  if (!cachedToken || cachedToken.expiresAt - Date.now() < 60_000) {
    const { stdout } = await run('databricks', ['auth', 'token', '--profile', PROFILE, '-o', 'json']);
    const t = JSON.parse(stdout);
    cachedToken = { token: t.access_token, expiresAt: t.expiry ? Date.parse(t.expiry) : Date.now() + 30 * 60_000 };
  }
  return { host, token: cachedToken.token };
}

// ---- SSE helpers ----------------------------------------------------------
async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (data) {
        try { yield JSON.parse(data); } catch { /* ignore malformed block */ }
      }
    }
  }
}

// ---- Answer post-processing ----------------------------------------------
// Chunks come back as: <chunk citation_id=".." source="file.pdf (p.12)">Title: ...
function parseChunks(output, files) {
  const re = /<chunk[^>]*source="([^"]+?)\s*\(p\.(\d+)\)"[^>]*>([\s\S]*?)(?=<chunk|$)/g;
  let m;
  while ((m = re.exec(output))) {
    const [, file, page, body] = m;
    const entry = files.get(file) || { file, title: null, pages: new Set() };
    entry.pages.add(Number(page));
    entry.title ||= body.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || null;
    files.set(file, entry);
  }
}

// The agent cites with \[[1](https://…filePreviewPath=file.pdf)\] links into the workspace,
// which students typically can't open. Replace them with plain [n] markers and build a
// source list from the retrieved chunks instead.
function finalizeAnswer(text, files) {
  const cited = new Map(); // n -> file name
  const clean = text.replace(/\s*\\?\[\[(\d+)\]\(([^)]*)\)\\?\]/g, (_, n, url) => {
    const file = decodeURIComponent(url.match(/filePreviewPath=([^&)]+)/)?.[1] || '');
    if (file) cited.set(n, file);
    return ` [${n}]`;
  });
  const sources = [...cited.entries()].map(([n, file]) => {
    const f = files.get(file);
    return {
      n: Number(n),
      file,
      title: f?.title || file.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '),
      pages: f ? [...f.pages].sort((a, b) => a - b) : [],
    };
  });
  return { text: clean, sources };
}

function statusFor(item) {
  if (item.type === 'reasoning') return 'Thinking…';
  if (item.type === 'function_call') {
    if (item.name === 'search_context_files') return 'Searching the textbooks…';
    return 'Analyzing…';
  }
  return null;
}

// ---- Chat endpoint --------------------------------------------------------
async function handleChat(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
  const message = String(payload.message || '').trim();
  if (!message) return json(res, 400, { error: 'Message is required' });
  if (message.length > MAX_MESSAGE_CHARS) return json(res, 400, { error: `Message too long (max ${MAX_MESSAGE_CHARS} characters)` });
  const conversationId = typeof payload.conversationId === 'string' && /^[\w-]+$/.test(payload.conversationId)
    ? payload.conversationId : undefined;

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
    const { host, token } = await getAuth();
    const upstream = await fetch(`${host}/api/2.0/genie/agents/${SPACE_ID}/responses`, {
      method: 'POST',
      signal: abort.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'genie-agent',
        stream: true,
        ...(conversationId && { conversation_id: conversationId }),
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] }],
      }),
    });
    if (!upstream.ok) {
      console.error('Upstream error', upstream.status, (await upstream.text()).slice(0, 500));
      send({ type: 'error', message: upstream.status === 401 || upstream.status === 403
        ? 'The assistant is not authorized to reach the textbooks right now.'
        : 'The assistant is unavailable right now. Please try again.' });
      return res.end();
    }

    const files = new Map();
    let answer = null, convId = conversationId, failed = null;
    send({ type: 'status', text: 'Thinking…' });

    for await (const ev of parseSSE(upstream.body)) {
      if (ev.type === 'response.created') {
        convId = ev.response?.conversation_id || convId;
      } else if (ev.type === 'response.output_item.added' || ev.type === 'response.output_item.done') {
        const item = ev.item || {};
        const s = ev.type.endsWith('added') ? statusFor(item) : null;
        if (s) send({ type: 'status', text: s });
        if (item.type === 'function_call_output' && typeof item.output === 'string') parseChunks(item.output, files);
        if (item.type === 'message' && ev.type.endsWith('done')) {
          answer = (item.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n');
        }
      } else if (ev.type === 'response.failed') {
        failed = ev.response?.error?.message || 'failed';
      } else if (ev.type === 'response.completed' && !answer) {
        const msg = (ev.response?.output || []).find(o => o.type === 'message');
        answer = (msg?.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n') || null;
      }
    }

    if (failed) {
      console.error('Genie response failed:', failed);
      send({ type: 'error', message: 'Something went wrong while answering. Please try rephrasing your question.' });
    } else if (!answer) {
      send({ type: 'error', message: "I couldn't find an answer in the course books. Try rephrasing your question." });
    } else {
      send({ type: 'answer', conversationId: convId, ...finalizeAnswer(answer, files) });
    }
  } catch (err) {
    if (!abort.signal.aborted || err?.message === 'timeout') {
      console.error('Chat error:', err);
      send({ type: 'error', message: err?.message === 'timeout'
        ? 'That took too long. Please try a narrower question.'
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

function readBody(req, limit = 64 * 1024) {
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
  if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true });
  if (req.method === 'GET') return serveStatic(req, res);
  json(res, 405, { error: 'Method not allowed' });
}).listen(PORT, () => console.log(`Textbook assistant running at http://localhost:${PORT}`));
