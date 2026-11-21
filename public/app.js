import { renderMarkdown } from './markdown.js';

const $ = id => document.getElementById(id);
const chat = $('chat'), messages = $('messages'), welcome = $('welcome');
const form = $('composer'), input = $('input'), sendBtn = $('send');

let conversationId = null;
let busy = false;

function scrollToBottom() { chat.scrollTop = chat.scrollHeight; }

function addMessage(kind, content) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${kind}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (typeof content === 'string') bubble.textContent = content;
  else if (content) bubble.append(content);
  wrap.append(bubble);
  messages.append(wrap);
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
      if (s.pages?.length) {
        const p = document.createElement('span'); p.className = 'pages';
        p.textContent = `· ${s.pages.length > 1 ? 'pp.' : 'p.'} ${formatPages(s.pages)}`;
        row.append(p);
      }
      box.append(row);
    }
    frag.append(box);
  }
  return frag;
}

function formatPages(pages) {
  const shown = pages.slice(0, 6).join(', ');
  return pages.length > 6 ? `${shown}…` : shown;
}

function setBusy(v) {
  busy = v;
  sendBtn.disabled = v || !input.value.trim();
}

async function ask(question) {
  if (busy || !question.trim()) return;
  welcome.hidden = true;
  addMessage('user', question);
  input.value = '';
  autosize();
  setBusy(true);

  const label = statusEl('Thinking…');
  const bot = addMessage('bot', label);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: question, conversationId }),
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
          label.querySelector('.label').textContent = ev.text;
        } else if (ev.type === 'answer') {
          conversationId = ev.conversationId || conversationId;
          bot.bubble.replaceChildren(answerEl(ev));
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

function showError(bot, text) {
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
$('new-chat').addEventListener('click', () => {
  if (busy) return;
  conversationId = null;
  messages.replaceChildren();
  welcome.hidden = false;
  input.focus();
});

input.focus();
