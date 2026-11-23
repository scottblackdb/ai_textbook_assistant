// Small, safe markdown renderer (headings, lists, tables, code, bold/italic, [n] citations).
// All input is HTML-escaped first, so no raw HTML from the model can reach the DOM.

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[(\d{1,2})\]/g, '<span class="cite">$1</span>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

// Models sometimes write LaTeX math (\( 150 \times \$12 \), \[ ... \], $$ ... $$) even when asked not to.
// There's no math renderer (strict CSP, no CDNs), so turn it into readable plain text with Unicode symbols.
const SYMBOLS = {
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', approx: '≈', neq: '≠', ne: '≠', leq: '≤', le: '≤', geq: '≥', ge: '≥',
  to: '→', rightarrow: '→', Rightarrow: '⇒', leftarrow: '←', implies: '⇒', infty: '∞', degree: '°', circ: '°', propto: '∝',
  sum: 'Σ', int: '∫', partial: '∂', nabla: '∇', sqrt: '√', ldots: '…', cdots: '⋯', dots: '…', percent: '%',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Theta: 'Θ', Phi: 'φ',
};
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '-': '⁻', '+': '⁺', n: 'ⁿ' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '-': '₋', '+': '₊' };
const script = (s, map, mark) => ([...s].every(c => map[c]) ? [...s].map(c => map[c]).join('') : `${mark}${s.length > 1 ? `(${s})` : s}`);
const group = s => (/^[\w.]+$/.test(s) ? s : `(${s})`);

function texToText(tex) {
  let s = tex
    .replace(/\^\s*\{?\s*\\circ\s*\}?/g, '°')
    .replace(/\\[dt]?frac\s*\{\s*1\s*\}\s*\{\s*([234])\s*\}/g, (_, d) => ({ 2: '½', 3: '⅓', 4: '¼' })[d]);
  for (let k = 0; k < 3; k++) { // a few passes so nested \frac{\text{a}}{b} unwinds
    s = s
      .replace(/\\(?:text|textbf|textit|mathrm|mathbf|mathit|operatorname|boxed)\s*\{([^{}]*)\}/g, '$1')
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => `${group(a.trim())}/${group(b.trim())}`)
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, a) => `√${group(a.trim())}`)
      .replace(/\^\{([^{}]*)\}/g, (_, a) => script(a, SUP, '^'))
      .replace(/_\{([^{}]*)\}/g, (_, a) => script(a, SUB, '_'));
  }
  return s
    .replace(/\^([\w+-])/g, (_, a) => script(a, SUP, '^'))
    .replace(/_(\d)/g, (_, a) => SUB[a])
    .replace(/\\(left|right|big|Big|bigg|Bigg)\b\s*/g, '')
    .replace(/\\([$%&#_{}])/g, '$1')
    .replace(/\\[,;:!]|\\quad|\\qquad|\\ /g, ' ')
    .replace(/\\\\/g, ' ')
    .replace(/\\([a-zA-Z]+)/g, (m, name) => SYMBOLS[name] ?? m)
    .replace(/[{}]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function stripLatex(src) {
  return src
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => `\n\n${texToText(t)}\n\n`)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => (/\n/.test(t) || t.length > 40 ? `\n\n${texToText(t)}\n\n` : texToText(t)))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => texToText(t))
    .replace(/\\([$%])/g, '$1'); // stray markdown escapes like \$12 outside math
}

// Apply outside fenced code blocks only.
const withoutCode = (src, fn) => src.split(/(^```[\s\S]*?(?:^```|$(?![\s\S])))/m).map((part, i) => (i % 2 ? part : fn(part))).join('');

const isTableSep =l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

export function renderMarkdown(src) {
  const lines = withoutCode(src.replace(/\r\n/g, '\n'), stripLatex).split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) { // fenced code
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    } else if (/^\s*$/.test(line)) {
      i++;
    } else if (/^#{1,4}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ''))}</h${level}>`);
      i++;
    } else if (line.includes('|') && isTableSep(lines[i + 1] || '')) {
      const head = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map(t => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
    } else if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>\s?|\s*([-*•]|\d+[.)])\s+)/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${inline(buf.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}
