/**
 * Tests for src/md.js — the tiny dependency-free markdown renderer that rules.html uses to
 * display combine-2026-spec.md directly (so the rules page can never drift from the spec).
 *
 * The spec is table-heavy and uses fenced code, nested lists, and inline formatting, so those
 * are the load-bearing cases. HTML-escaping matters because the rendered output is injected
 * into the page — unescaped markup in the source must not become live DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from '../src/md.js';

test('headings render at every level', () => {
  assert.match(renderMarkdown('# Title'), /<h1>Title<\/h1>/);
  assert.match(renderMarkdown('### 3.1 The Knob'), /<h3>3\.1 The Knob<\/h3>/);
  assert.match(renderMarkdown('###### Six'), /<h6>Six<\/h6>/);
});

test('inline bold, italic, and code', () => {
  assert.match(renderMarkdown('a **bold** b'), /<strong>bold<\/strong>/);
  assert.match(renderMarkdown('a *ital* b'), /<em>ital<\/em>/);
  assert.match(renderMarkdown('a `code` b'), /<code>code<\/code>/);
});

test('inline code content is HTML-escaped and never re-formatted', () => {
  const html = renderMarkdown('`<b> & **x**`');
  assert.match(html, /<code>&lt;b&gt; &amp; \*\*x\*\*<\/code>/);
  assert.doesNotMatch(html, /<strong>/);
});

test('a wrapped paragraph collapses to one <p>; a blank line splits paragraphs', () => {
  assert.match(renderMarkdown('line one\nline two'), /<p>line one line two<\/p>/);
  const two = renderMarkdown('one\n\ntwo');
  assert.match(two, /<p>one<\/p>/);
  assert.match(two, /<p>two<\/p>/);
});

test('unordered list', () => {
  const html = renderMarkdown('- a\n- b');
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
});

test('nested unordered list (2-space indent, as spec §8 uses)', () => {
  const html = renderMarkdown('- top\n  - child1\n  - child2');
  assert.match(html, /<li>top<ul><li>child1<\/li><li>child2<\/li><\/ul><\/li>/);
});

test('ordered list', () => {
  const html = renderMarkdown('1. first\n2. second');
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
});

test('fenced code block: escaped, and inline markers stay literal', () => {
  const html = renderMarkdown('```\nraw = 100 × (n − r)\n**not bold** <x>\n```');
  assert.match(html, /<pre><code>/);
  assert.match(html, /raw = 100/);
  assert.match(html, /\*\*not bold\*\*/); // literal, not <strong>
  assert.match(html, /&lt;x&gt;/); // escaped
  assert.doesNotMatch(html, /<strong>/);
});

test('GFM table with header, separator, rows', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<table>/);
  assert.match(html, /<thead>[\s\S]*<th>A<\/th><th>B<\/th>[\s\S]*<\/thead>/);
  assert.match(html, /<tbody>[\s\S]*<td>1<\/td><td>2<\/td>[\s\S]*<\/tbody>/);
});

test('table cells run inline formatting', () => {
  const html = renderMarkdown('| **x** | `y` |\n|---|---|\n| a | b |');
  assert.match(html, /<th><strong>x<\/strong><\/th>/);
  assert.match(html, /<th><code>y<\/code><\/th>/);
});

test('table with fewer body cells pads to header width (no undefined)', () => {
  const html = renderMarkdown('| A | B | C |\n|---|---|---|\n| 1 | 2 |');
  assert.match(html, /<td>1<\/td><td>2<\/td><td><\/td>/);
  assert.doesNotMatch(html, /undefined/);
});

test('blockquote', () => {
  const html = renderMarkdown('> quoted line');
  assert.match(html, /<blockquote>[\s\S]*quoted line[\s\S]*<\/blockquote>/);
});

test('horizontal rule', () => {
  assert.match(renderMarkdown('---'), /<hr>/);
  assert.match(renderMarkdown('one\n\n---\n\ntwo'), /<hr>/);
});

test('a --- divider is an <hr>, not a list item or heading', () => {
  const html = renderMarkdown('---');
  assert.doesNotMatch(html, /<li>/);
  assert.doesNotMatch(html, /<h\d>/);
});

test('HTML in the source text is escaped (no injection)', () => {
  const html = renderMarkdown('before <script>alert(1)</script> after & <b>');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('links', () => {
  assert.match(renderMarkdown('[text](https://x.y/z)'), /<a href="https:\/\/x\.y\/z">text<\/a>/);
});

test('renderMarkdown never throws and returns a string for odd input', () => {
  for (const s of ['', '   ', '```\nunclosed', '| a |', '#', '- ', '>']) {
    assert.equal(typeof renderMarkdown(s), 'string');
  }
});

test('integration: the real spec renders to structured HTML', () => {
  const specPath = fileURLToPath(new URL('../combine-2026-spec.md', import.meta.url));
  const html = renderMarkdown(readFileSync(specPath, 'utf8'));
  assert.match(html, /<h1>/); // "# 2026 Fantasy Football Combine…"
  assert.match(html, /<h2>/); // "## 1. Context" etc.
  assert.match(html, /<table>/); // the events / burn tables
  assert.match(html, /<pre><code>/); // the roster / formula code fences
  assert.ok(/<ul>|<ol>/.test(html)); // §9 agenda / §10 rules lists
  // The spec's "&" (Specification & Handoff) must be escaped, never a raw entity-less ampersand
  // followed by a word that a browser could misread as an entity.
  assert.doesNotMatch(html, /Specification & Handoff/);
  assert.match(html, /Specification &amp; Handoff/);
});
