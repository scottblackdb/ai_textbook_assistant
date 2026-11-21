import { renderMarkdown } from './markdown.js';

const $ = id => document.getElementById(id);
const chat = $('chat'), welcome = $('welcome');
const form = $('composer'), input = $('input'), sendBtn = $('send');
const segs = [...document.querySelectorAll('.seg')];

// Each mode keeps its own transcript so switching never mixes conversations.
const modes = {
  genie:  { el: $('messages-genie'),  conversationId: null, history: [], hint: 'Genie agent searching your course PDFs. May contain mistakes; check important details in the book.' },
  vector: { el: $('messages-vector'), conversationId: null, history: [], hint: vectorHint('a foundation model') },
};
const MAX_HISTORY = 8; // the server only uses the last 8 messages

function vectorHint(model) {
  return `Vector search over the course books, answered by ${model}. May contain mistakes; check important details in the book.`;
}
let mode = 'genie';
try { const saved = localStorage.getItem('mode'); if (saved && modes[saved]) mode = saved; } catch { /* storage unavailable */ }
let busy = false;

const scrollToBottom = () => { chat.scrollTop = chat.scrollHeight; };

function setMode(next) {
  if (busy || !modes[next]) return;
  mode = next;
  try { localStorage.setItem('mode', mode); } catch { /* ignore */ }
  for (const [key, m] of Object.entries(modes)) m.el.hidden = key !== mode;
  for (const s of segs) s.setAttribute('aria-checked', String(s.dataset.mode === mode));
  welcome.hidden = modes[mode].el.childElementCount > 0;
  $('hint').textContent = modes[mode].hint;
  scrollToBottom();
  input.focus();
}

function addMessage(kind, content) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${kind}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (typeof content === 'string') bubble.textContent = content;
  else if (content) bubble.append(content);
  wrap.append(bubble);
  modes[mode].el.append(wrap);
  scrollToBottom();
  return { wrap, bubble };
}

function statusEl(text) {
  const el = document.createElement('div');
  el.className = 'status';
  el.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span class="label"></span>';
  el.querySelector('.label').textContent = text;
  return el;
}

const formatPages = pages => {
  const shown = pages.slice(0, 6).join(', ');
  return pages.length > 6 ? `${shown}…` : shown;
};

function sourceLabel(s) {
  if (s.pagesLabel) return s.pagesLabel;
  if (s.pages?.length) return `${s.pages.length > 1 ? 'pp.' : 'p.'} ${formatPages(s.pages)}`;
  return '';
}

function answerEl({ text, sources }) {
  const frag = document.createDocumentFragment();
  const md = document.createElement('div');
  md.className = 'md';
  md.innerHTML = renderMarkdown(text);
  frag.append(md);
  if (sources?.length) {
    const box = document.createElement('div');
    box.className = 'sources';
    const h = document.createElement('h3');
    h.textContent = 'Sources';
    box.append(h);
    for (const s of sources) {
      const row = document.createElement('div');
      row.className = 'source';
      const n = document.createElement('span'); n.className = 'n'; n.textContent = `[${s.n}]`;
      const title = document.createElement('span'); title.textContent = s.title;
      row.append(n, title);
      const label = sourceLabel(s);
      if (label) {
        const p = document.createElement('span'); p.className = 'pages'; p.textContent = `· ${label}`;
        row.append(p);
      }
      box.append(row);
    }
    frag.append(box);
  }
  return frag;
}

function setBusy(v) {
  busy = v;
  sendBtn.disabled = v || !input.value.trim();
  for (const s of segs) s.disabled = v;
}

async function ask(question) {
  if (busy || !question.trim()) return;
  const state = modes[mode];
  const thisMode = mode;
  welcome.hidden = true;
  addMessage('user', question);
  input.value = '';
  autosize();
  setBusy(true);

  const label = statusEl('Thinking…');
  const bot = addMessage('bot', label);
  let streamed = '';
  const startedAt = performance.now();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: thisMode, message: question,
        conversationId: state.conversationId,
        history: thisMode === 'vector' ? state.history.slice(-MAX_HISTORY) : undefined,
      }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Request failed');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', done = false;
    while (true) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'status') {
          if (!streamed) label.querySelector('.label').textContent = ev.text;
        } else if (ev.type === 'delta') {
          streamed += ev.text;
          bot.wrap.classList.add('streaming');
          bot.bubble.innerHTML = `<div class="md">${renderMarkdown(streamed)}</div>`;
        } else if (ev.type === 'answer') {
          state.conversationId = ev.conversationId || state.conversationId;
          state.history.push({ role: 'user', content: question }, { role: 'assistant', content: ev.text });
          state.history = state.history.slice(-MAX_HISTORY);
          bot.wrap.classList.remove('streaming');
          bot.bubble.replaceChildren(answerEl(ev));
          addMeta(bot, performance.now() - startedAt, ev.meta);
          done = true;
        } else if (ev.type === 'error') {
          showError(bot, ev.message);
          done = true;
        }
        scrollToBottom();
      }
    }
    if (!done) showError(bot, 'The connection ended unexpectedly. Please try again.');
  } catch (err) {
    showError(bot, err.message || 'Something went wrong. Please try again.');
  } finally {
    setBusy(false);
    input.focus();
  }
}

function formatElapsed(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

// e.g. "Genie · 12 s" or "Lakebase · gpt-6-luna · medium effort · 4.3 s"
function addMeta(bot, ms, info = {}) {
  const parts = [];
  if (info.source) parts.push(info.source);
  if (info.model) parts.push(info.model.replace(/^databricks-/, ''));
  if (info.effort) parts.push(`${info.effort} effort${info.effortSource === 'default' ? ' (default)' : ''}`);
  parts.push(formatElapsed(ms));

  let effortDetail = '';
  if (info.effortSource === 'ai_decide') {
    effortDetail = `; effort chosen by ai_decide${info.effortConfidence != null ? ` (${Math.round(info.effortConfidence * 100)}% confidence)` : ''}`;
  } else if (info.effortSource === 'default') {
    effortDetail = `; ai_decide unavailable, default effort used${info.effortReason ? ` (${info.effortReason})` : ''}`;
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = parts.join(' · ');
  meta.title = info.source === 'Lakebase'
    ? `Answered from Lakebase vector search by ${info.model}, reasoning effort ${info.effort}${effortDetail}. Took ${formatElapsed(ms)}.`
    : `Answered by the ${info.source || 'assistant'} in ${formatElapsed(ms)}`;
  bot.wrap.append(meta);
}

function showError(bot, text) {
  bot.wrap.classList.remove('streaming');
  bot.wrap.classList.add('error');
  bot.bubble.textContent = text;
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

input.addEventListener('input', () => { autosize(); sendBtn.disabled = busy || !input.value.trim(); });
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});
form.addEventListener('submit', e => { e.preventDefault(); ask(input.value); });
$('suggestions').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (chip) ask(chip.textContent);
});
for (const s of segs) s.addEventListener('click', () => setMode(s.dataset.mode));
$('new-chat').addEventListener('click', () => {
  if (busy) return;
  const state = modes[mode];
  state.conversationId = null;
  state.history = [];
  state.el.replaceChildren();
  welcome.hidden = false;
  input.focus();
});

setMode(mode);

// Show the model the server is actually configured with.
fetch('/api/config').then(r => (r.ok ? r.json() : null)).then(cfg => {
  if (!cfg?.vectorModel) return;
  const model = cfg.vectorModel.replace(/^databricks-/, '');
  modes.vector.hint = vectorHint(model);
  const seg = segs.find(s => s.dataset.mode === 'vector');
  if (seg) seg.title = `Vector search in Lakebase, answered by ${model}`;
  if (mode === 'vector') $('hint').textContent = modes.vector.hint;
}).catch(() => { /* keep generic hint */ });
