// Mode 2: classic RAG. Embed the question, search pgvector in Lakebase, answer with
// a Databricks foundation model (gpt-6-luna) grounded in the retrieved excerpts.
import pg from 'pg';
import { dbFetch, dbJson } from './auth.js';
import { decideEffort } from './effort.js';

const LAKEBASE_ENDPOINT = process.env.LAKEBASE_ENDPOINT || 'projects/shared/branches/production/endpoints/primary';
const PGDATABASE = process.env.PGDATABASE || 'textbooks';
const EMBEDDING_ENDPOINT = process.env.EMBEDDING_ENDPOINT || 'databricks-gte-large-en'; // matches stored vectors (1024-d)
export const CHAT_ENDPOINT = process.env.RAG_CHAT_ENDPOINT || 'databricks-gpt-6-luna';
const TOP_K = Number(process.env.RAG_TOP_K || 6);
// Reasoning effort for the answer call is chosen per question by ai_decide (lib/effort.js).
// The endpoint doesn't echo the level it used, so we always send it explicitly and report what we sent.
const MAX_HISTORY_MESSAGES = 8;

// ---- Lakebase connection (OAuth token as password, refreshed before expiry) ----
let pgHostPromise, pgUserPromise, dbToken = null;
let poolPromise = null; // cached promise so concurrent first requests share one pool

const pgHost = () => (pgHostPromise ||= process.env.PGHOST
  ? Promise.resolve(process.env.PGHOST)
  : dbJson(`/api/2.0/postgres/${LAKEBASE_ENDPOINT}`).then(e => e.status.hosts.host).catch(e => { pgHostPromise = null; throw e; }));

const pgUser = () => (pgUserPromise ||= process.env.PGUSER
  ? Promise.resolve(process.env.PGUSER)
  : dbJson('/api/2.0/preview/scim/v2/Me').then(me => me.userName).catch(e => { pgUserPromise = null; throw e; }));

async function pgPassword() {
  if (!dbToken || dbToken.expiresAt - Date.now() < 5 * 60_000) {
    const r = await dbJson('/api/2.0/postgres/credentials', { method: 'POST', body: { endpoint: LAKEBASE_ENDPOINT } });
    dbToken = { token: r.token, expiresAt: r.expire_time ? Date.parse(r.expire_time) : Date.now() + 50 * 60_000 };
  }
  return dbToken.token;
}

function getPool() {
  poolPromise ||= (async () => {
    const p = new pg.Pool({
      host: await pgHost(), user: await pgUser(), database: PGDATABASE, port: 5432,
      password: pgPassword, ssl: true, max: 5, idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 20_000, // allows for scale-to-zero wake-up
    });
    p.on('error', err => console.error('pg pool error', err.message));
    return p;
  })().catch(err => { poolPromise = null; throw err; });
  return poolPromise;
}

// Replace the pool only if it is still the one that failed, so concurrent
// failures don't end a pool another request is using or just rebuilt.
async function resetPool(failed) {
  if (poolPromise !== failed) return;
  poolPromise = null;
  dbToken = null;
  (await failed.catch(() => null))?.end().catch(() => {});
}

// Connection/auth problems are worth one retry on a fresh pool; SQL errors are not.
const RETRYABLE_PG = new Set(['28000', '28P01', '57P01', '57P02', '57P03', '08000', '08003', '08006', '08001', '08004']);
function isRetryable(err) {
  if (err?.code && RETRYABLE_PG.has(err.code)) return true;
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(err?.code)) return true;
  return /timeout|terminat|Connection|socket/i.test(err?.message || '');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

// ---- Retrieval ----
async function embed(text, signal) {
  const r = await dbJson(`/serving-endpoints/${EMBEDDING_ENDPOINT}/invocations`, { method: 'POST', body: { input: [text] }, signal });
  return r.data[0].embedding;
}

async function search(question, signal) {
  const vec = `[${(await embed(question, signal)).join(',')}]`;
  const run = async () => {
    throwIfAborted(signal);
    const current = getPool();
    try {
      const rows = (await (await current).query(
        `SELECT source_file, page_start, page_end, content, 1 - (embedding <=> $1::vector) AS score
           FROM textbook_chunks ORDER BY embedding <=> $1::vector LIMIT $2`, [vec, TOP_K])).rows;
      throwIfAborted(signal);
      return rows;
    } catch (err) {
      err.pool = current;
      throw err;
    }
  };
  try { return await run(); }
  catch (err) {
    if (signal?.aborted || !isRetryable(err)) throw err;
    console.warn('Lakebase connection failed, retrying with a fresh pool:', err.message);
    await resetPool(err.pool);
    return run();
  }
}

// ---- Generation ----
const SYSTEM_PROMPT = `You are Course Companion, a friendly tutor helping students understand their course textbooks.
Answer using ONLY the numbered textbook excerpts provided with the question.
- Cite the excerpts that support each claim with their number in square brackets, like [1] or [2][3]. Never invent citations.
- If the excerpts don't contain the answer, say you couldn't find it in the course books and suggest how to rephrase. Don't answer from outside knowledge.
- Explain clearly for a student. Be concise, use Markdown (short headings, bullets, tables or worked examples where useful).
- Excerpts come from PDF text extraction, so they may contain broken lines or stray characters; read past them.`;

const prettyTitle = f => f.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const pageLabel = ({ page_start: a, page_end: b }) => (!a ? '' : a === b || !b ? `p. ${a}` : `pp. ${a}–${b}`);

function buildUserPrompt(question, chunks) {
  const ctx = chunks.map((c, i) => `[${i + 1}] ${prettyTitle(c.source_file)}, ${pageLabel(c)}\n${c.content}`).join('\n\n---\n\n');
  return `Textbook excerpts:\n\n${ctx}\n\nStudent question: ${question}`;
}

async function chatCompletion(messages, { stream = false, maxTokens, effort, signal } = {}) {
  const res = await dbFetch(`/serving-endpoints/${CHAT_ENDPOINT}/invocations`, {
    method: 'POST', signal,
    body: { messages, stream, ...(maxTokens && { max_tokens: maxTokens }), ...(effort && { reasoning_effort: effort }) },
  });
  if (!res.ok) throw new Error(`${CHAT_ENDPOINT} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function* streamTokens(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) yield delta;
      } catch { /* partial JSON, ignore */ }
    }
  }
}

// Turn a follow-up ("what about liabilities?") into a standalone search query.
async function standaloneQuestion(question, history, signal) {
  if (!history.length) return question;
  try {
    const transcript = history.map(m => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.content.slice(0, 600)}`).join('\n');
    const res = await chatCompletion([
      { role: 'system', content: 'Rewrite the student\'s last message as a single standalone search query for a textbook, resolving pronouns and references from the conversation. Output only the query.' },
      { role: 'user', content: `${transcript}\nStudent: ${question}` },
    ], { maxTokens: 80, effort: 'none', signal }); // simple rewrite: keep it fast
    const q = (await res.json()).choices?.[0]?.message?.content?.trim();
    return q || question;
  } catch (err) {
    if (signal?.aborted) throw err;
    return question;
  }
}

// Normalize "[1, 3]" -> "[1] [3]" and "[1–3]" -> "[1] [2] [3]", then build the
// source list from the citations actually used.
function expandCitationList(list, max) {
  const nums = [];
  for (const part of list.split(/\s*[,;]\s*/)) {
    const range = part.match(/^(\d+)\s*[–—-]\s*(\d+)$/);
    if (range) {
      const a = Number(range[1]), b = Number(range[2]);
      if (a <= b && b - a <= max) for (let n = a; n <= b; n++) nums.push(n);
      else nums.push(a, b);
    } else if (/^\d+$/.test(part)) nums.push(Number(part));
  }
  return nums.map(n => `[${n}]`).join(' ');
}

function finalize(text, chunks) {
  const clean = text.replace(/\[(\d+(?:\s*[,;–—-]\s*\d+)+)\]/g, (_, list) => expandCitationList(list, chunks.length));
  const used = [...new Set([...clean.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1])))]
    .filter(n => n >= 1 && n <= chunks.length).sort((a, b) => a - b);
  return {
    text: clean,
    sources: used.map(n => {
      const c = chunks[n - 1];
      return { n, title: prettyTitle(c.source_file), pagesLabel: pageLabel(c) };
    }),
  };
}

/** payload: { message, history: [{role, content}] }. Emits status/delta/answer/error via send(). */
export async function chat({ message, history = [] }, send, signal) {
  const hist = history
    .filter(m => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY_MESSAGES)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));

  send({ type: 'status', text: 'Searching the textbooks…' });
  const query = await standaloneQuestion(message, hist, signal);
  // Effort decision runs in parallel with retrieval so it adds little or no latency.
  // It gets the standalone query so follow-ups like "give an example of it" are judged in context.
  const [chunks, decision] = await Promise.all([search(query, signal), decideEffort(query, signal)]);
  throwIfAborted(signal);
  if (!chunks.length) {
    return send({ type: 'error', message: "I couldn't find anything in the course books for that question." });
  }

  send({ type: 'status', text: 'Writing an answer…' });
  const res = await chatCompletion([
    { role: 'system', content: SYSTEM_PROMPT },
    ...hist,
    { role: 'user', content: buildUserPrompt(message, chunks) },
  ], { stream: true, effort: decision.effort, signal });

  let text = '';
  for await (const delta of streamTokens(res)) {
    text += delta;
    send({ type: 'delta', text: delta });
  }
  if (!text.trim()) {
    return send({ type: 'error', message: "I couldn't put together an answer. Please try rephrasing your question." });
  }
  send({
    type: 'answer', ...finalize(text, chunks),
    meta: {
      source: 'Lakebase', model: CHAT_ENDPOINT,
      effort: decision.effort, effortSource: decision.source,
      ...(decision.confidence != null && { effortConfidence: decision.confidence }),
      ...(decision.reason && { effortReason: decision.reason }),
    },
  });
}
