// Mode 1: Databricks Genie agent (Agent mode API) searching the course PDFs.
import { dbFetch } from './auth.js';

export const SPACE_ID = process.env.GENIE_SPACE_ID || '01f1e49951b91151bc1e88b97cc6517a';

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
  const cited = new Map();
  const clean = text.replace(/\s*\\?\[\[(\d+)\]\(([^)]*)\)\\?\]/g, (_, n, url) => {
    const file = decodeURIComponent(url.match(/filePreviewPath=([^&)]+)/)?.[1] || '');
    if (file) cited.set(n, file);
    return ` [${n}]`;
  });
  const sources = [...cited.entries()].map(([n, file]) => {
    const f = files.get(file);
    return {
      n: Number(n),
      title: f?.title || file.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '),
      pages: f ? [...f.pages].sort((a, b) => a - b) : [],
    };
  });
  return { text: clean, sources };
}

function statusFor(item) {
  if (item.type === 'reasoning') return 'Thinking…';
  if (item.type === 'function_call') return item.name === 'search_context_files' ? 'Searching the textbooks…' : 'Analyzing…';
  return null;
}

/** payload: { message, conversationId }. Emits status/answer/error via send(). */
export async function chat({ message, conversationId }, send, signal) {
  const upstream = await dbFetch(`/api/2.0/genie/agents/${SPACE_ID}/responses`, {
    method: 'POST',
    signal,
    body: {
      model: 'genie-agent',
      stream: true,
      ...(conversationId && { conversation_id: conversationId }),
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] }],
    },
  });
  if (!upstream.ok) {
    console.error('Genie upstream error', upstream.status, (await upstream.text()).slice(0, 500));
    return send({ type: 'error', message: upstream.status === 401 || upstream.status === 403
      ? 'The assistant is not authorized to reach the textbooks right now.'
      : 'The assistant is unavailable right now. Please try again.' });
  }

  const files = new Map();
  let answer = null, convId = conversationId, failed = null;
  send({ type: 'status', text: 'Thinking…' });

  for await (const ev of parseSSE(upstream.body)) {
    if (ev.type === 'response.created') {
      convId = ev.response?.conversation_id || convId;
    } else if (ev.type === 'response.output_item.added' || ev.type === 'response.output_item.done') {
      const item = ev.item || {};
      const isDone = ev.type.endsWith('done');
      const s = isDone ? null : statusFor(item);
      if (s) send({ type: 'status', text: s });
      if (item.type === 'function_call_output' && typeof item.output === 'string') parseChunks(item.output, files);
      if (item.type === 'message' && isDone) {
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
    send({ type: 'answer', conversationId: convId, ...finalizeAnswer(answer, files), meta: { source: 'Genie' } });
  }
}
