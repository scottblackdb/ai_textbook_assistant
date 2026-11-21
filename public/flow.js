// Flow pane: one card per question showing the path the answer took, updated live from
// the server's `step` events ({ node, state: 'active'|'done'|'error', detail?, ms? }).

const ICONS = {
  question: '<path d="M4 4h16v12H8l-4 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9.5 8.5a2.5 2.5 0 1 1 3.2 2.4c-.5.2-.7.6-.7 1.1M12 14.5v.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  genie: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z" fill="currentColor"/>',
  rewrite: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  embed: '<path d="M5 5h3M5 12h3M5 19h3M10.5 5h3M10.5 12h3M10.5 19h3M16 5h3M16 12h3M16 19h3" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  lakebase: '<ellipse cx="12" cy="5.5" rx="7" ry="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" fill="none" stroke="currentColor" stroke-width="2"/>',
  decide: '<path d="M4 17a8 8 0 1 1 16 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 17l4-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.6" fill="currentColor"/>',
  luna: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" fill="currentColor"/>',
  answer: '<path d="M6 3h9l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 13l2.2 2.2L16 10.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
};

const svg = name => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">${ICONS[name]}</svg>`;

const formatMs = ms => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function nodeEl(id, title, icon) {
  const el = document.createElement('div');
  el.className = 'fnode';
  el.dataset.node = id;
  el.dataset.state = 'pending';
  el.innerHTML = `<span class="ficon">${svg(icon)}</span><div class="fbody"><div class="ftitle"><span class="fname"></span><span class="fms"></span></div><div class="fdetail"></div></div>`;
  el.querySelector('.fname').textContent = title;
  return el;
}

const line = () => Object.assign(document.createElement('div'), { className: 'fline' });

/**
 * Build a flow card at the top of `container`.
 * opts: { mode: 'genie'|'vector', question, hasHistory, lunaLabel, onSelect }
 * Returns { step(ev), finish(ms, meta), fail(message) }.
 */
export function createTrace(container, { mode, question, hasHistory, lunaLabel = 'Luna', onSelect }) {
  for (const c of container.querySelectorAll('.trace.current')) c.classList.remove('current');

  const card = document.createElement('article');
  card.className = 'trace current';
  card.tabIndex = 0;
  card.setAttribute('aria-label', `How this question was answered: ${question}`);
  card.innerHTML = `<header class="trace-head"><div class="trace-q"></div><div class="trace-meta"><span class="badge"></span><span class="trace-time">running…</span></div></header><div class="flow"></div>`;
  card.querySelector('.trace-q').textContent = question;
  card.querySelector('.badge').textContent = mode === 'genie' ? 'Genie' : 'Lakebase';
  card.querySelector('.badge').dataset.mode = mode;
  const flow = card.querySelector('.flow');
  const nodes = {};
  const add = (parent, id, title, icon) => (nodes[id] = parent.appendChild(nodeEl(id, title, icon)));

  add(flow, 'question', 'Question', 'question');
  if (mode === 'genie') {
    flow.append(line()); add(flow, 'genie', 'Genie Agent', 'genie');
  } else {
    if (hasHistory) { flow.append(line()); add(flow, 'rewrite', 'Rewrite follow-up', 'rewrite'); }
    flow.append(line());
    // Retrieval and the effort decision run in parallel, then both feed the model.
    const fork = document.createElement('div');
    fork.className = 'ffork';
    const left = fork.appendChild(Object.assign(document.createElement('div'), { className: 'fcol' }));
    const right = fork.appendChild(Object.assign(document.createElement('div'), { className: 'fcol' }));
    add(left, 'embed', 'Embedding', 'embed');
    left.append(line());
    add(left, 'lakebase', 'Lakebase', 'lakebase');
    add(right, 'decide', 'ai_decide', 'decide');
    flow.append(fork, line());
    add(flow, 'luna', lunaLabel, 'luna');
  }
  flow.append(line()); add(flow, 'answer', 'Answer', 'answer');

  set('question', 'done', truncate(question, 80));
  container.prepend(card);
  card.addEventListener('click', () => onSelect?.());
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(); } });

  function set(id, state, detail, ms) {
    const n = nodes[id];
    if (!n) return;
    n.dataset.state = state;
    if (detail != null) n.querySelector('.fdetail').textContent = detail;
    if (ms != null) n.querySelector('.fms').textContent = formatMs(ms);
  }

  return {
    step(ev) { set(ev.node, ev.state, ev.detail, ev.ms); },
    finish(ms) {
      card.querySelector('.trace-time').textContent = formatMs(Math.round(ms));
      card.classList.add('finished');
    },
    fail(message) {
      for (const n of Object.values(nodes)) {
        if (n.dataset.state === 'active') n.dataset.state = 'error';
        else if (n.dataset.state === 'pending') n.dataset.state = 'skipped';
      }
      if (message) set('answer', 'error', message);
      card.querySelector('.trace-time').textContent = 'failed';
      card.classList.add('finished', 'failed');
    },
  };
}
