/**
 * A tiny, dependency-free Markdown → HTML renderer.
 *
 * Its one job is rules.html: fetch the checked-in combine-2026-spec.md and render it in the
 * browser, so the rules page reads the source of truth directly and can NEVER drift from it.
 * That scope is deliberate — this is not a general-purpose Markdown library. It supports exactly
 * the constructs the spec uses: ATX headings, GFM pipe tables, nested bullet/ordered lists,
 * fenced code, blockquotes, horizontal rules, and inline **bold** / *italic* / `code` / [links].
 *
 * Security: all text is HTML-escaped. The rendered output is injected into the page, and while
 * the spec is trusted today, an escaping renderer means a future edit that pastes markup can't
 * turn into live DOM. Fenced/inline code is escaped too and never re-parsed for inline markers.
 */

const CODE_SENTINEL = '\u0000';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Gate a link href. A relative path, bare fragment (#…), or anything with no scheme is safe; a URL
 * that DOES carry a scheme is allowed only for http(s)/mailto. Returns the url when safe, else null
 * so the caller can drop the link to plain text. javascript:/data:/vbscript: therefore never link.
 */
function safeUrl(url) {
  const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url);
  if (!scheme) return url; // relative, ./…, ../…, #anchor — no scheme, safe
  return /^(https?|mailto)$/i.test(scheme[1]) ? url : null;
}

/**
 * Inline pass. Code spans are pulled out first (so their contents are escaped but never treated
 * as bold/italic/link markup), then the remaining text is escaped, then links and emphasis are
 * applied, then the code spans are spliced back in.
 */
function renderInline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push('<code>' + escapeHtml(c) + '</code>');
    return CODE_SENTINEL + (codes.length - 1) + CODE_SENTINEL;
  });

  s = escapeHtml(s);

  // Links: [text](url). The url was escaped above, which is what we want inside href="". A link
  // whose scheme isn't http(s)/mailto (notably javascript:/data:) survives escaping untouched and
  // would execute on click, so it's rejected to plain text — the file's "no future edit turns into
  // live DOM" invariant (see header) covers link hrefs, not just markup.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const safe = safeUrl(url);
    return safe ? `<a href="${safe}">${label}</a>` : label;
  });

  // Bold before italic so ** is consumed before a lone * can match.
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  s = s.replace(new RegExp(CODE_SENTINEL + '(\\d+)' + CODE_SENTINEL, 'g'), (_, n) => codes[Number(n)]);
  return s;
}

const HR_RE = /^ {0,3}([-*_])( *\1){2,} *$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM_RE = /^( *)([-*+]|\d+\.)\s+(.*)$/;
const BLOCKQUOTE_RE = /^ {0,3}>/;

function isTableSeparator(line) {
  if (line == null || !line.includes('-')) return false;
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = trimmed.split('|');
  return cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

function isTableStart(line, next) {
  return line != null && line.includes('|') && isTableSeparator(next);
}

/** Does this line begin a new block? Used to end a paragraph that isn't followed by a blank line. */
function isBlockStart(line, next) {
  if (line == null) return false;
  if (/^```/.test(line)) return true;
  if (HEADING_RE.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (BLOCKQUOTE_RE.test(line)) return true;
  if (LIST_ITEM_RE.test(line)) return true;
  if (isTableStart(line, next)) return true;
  return false;
}

function splitRow(row) {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

function parseTable(lines, start) {
  const header = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  });
  const styleFor = (n) => (aligns[n] ? ` style="text-align:${aligns[n]}"` : '');

  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
    rows.push(splitRow(lines[i]));
    i += 1;
  }

  let html = '<table>\n<thead>\n<tr>';
  header.forEach((c, n) => {
    html += `<th${styleFor(n)}>${renderInline(c)}</th>`;
  });
  html += '</tr>\n</thead>\n<tbody>\n';
  for (const row of rows) {
    html += '<tr>';
    for (let n = 0; n < header.length; n += 1) {
      html += `<td${styleFor(n)}>${renderInline(row[n] ?? '')}</td>`;
    }
    html += '</tr>\n';
  }
  html += '</tbody>\n</table>';
  return { html, next: i };
}

function parseList(lines, start) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST_ITEM_RE);
    if (!m) break;
    items.push({ indent: m[1].length, ordered: /^\d/.test(m[2]), text: m[3] });
    i += 1;
  }

  let idx = 0;
  function build(base) {
    const { ordered } = items[idx];
    const tag = ordered ? 'ol' : 'ul';
    let html = `<${tag}>`;
    while (idx < items.length && items[idx].indent >= base) {
      if (items[idx].indent > base) break; // defensive: unexpected deeper indent without a parent
      const item = items[idx];
      idx += 1;
      let li = '<li>' + renderInline(item.text);
      if (idx < items.length && items[idx].indent > base) {
        li += build(items[idx].indent);
      }
      li += '</li>';
      html += li;
    }
    html += `</${tag}>`;
    return html;
  }
  // Drain every collected item. build() consumes one list nested at `base`; if a later item is LESS
  // indented than the first (a dedent build() can't reach), loop so it still emits — otherwise those
  // items would be silently dropped while `next` skips past their lines. Well-formed nesting runs the
  // loop exactly once (items[0] is the minimum indent).
  let html = '';
  while (idx < items.length) html += build(items[idx].indent);
  return { html, next: i };
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    if (/^```/.test(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // skip the closing fence (harmless if it was never opened-closed)
      out.push('<pre><code>' + escapeHtml(body.join('\n')) + '</code></pre>');
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && BLOCKQUOTE_RE.test(lines[i])) {
        inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
        i += 1;
      }
      out.push('<blockquote>' + renderMarkdown(inner.join('\n')) + '</blockquote>');
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const { html, next } = parseTable(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      const { html, next } = parseList(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i], lines[i + 1])) {
      para.push(lines[i]);
      i += 1;
    }
    out.push('<p>' + renderInline(para.join(' ').trim()) + '</p>');
  }

  return out.join('\n');
}
