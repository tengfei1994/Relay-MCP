import assert from "node:assert/strict";
import test from "node:test";
import {parseHelpHtml} from "../src/knowledge/parsers.ts";
import {htmlToStructuredMarkdown,normalizeProductMarkup,legacyProductMarkupForReplay} from "../src/knowledge/weknora-markdown.ts";

test("highlighted pre preserves br line endings in exact fenced code",()=>{
  const body=htmlToStructuredMarkdown('<h1>Code</h1><pre><code><span>first  </span><br><span>second</span><br><br>  third &lt;x&gt;</code></pre>').markdown;
  assert.ok(body.includes('```\nfirst  \nsecond\n\n  third <x>\n```'));
  assert.equal(normalizeProductMarkup(body),body);
});

test("linked pre keeps source code and references in a protected static HTML block",()=>{
  const body=htmlToStructuredMarkdown('<h1>Before</h1><pre><code>first  <br><a href="keyword.htm#original">second</a><br><br>  third &lt;x&gt;</code></pre><h2>After</h2>').markdown;
  assert.ok(body.includes('<pre data-relay-structure="pre"><code>first  <br><a href="keyword.htm#original">second</a><br><br>  third &lt;x&gt;</code></pre>'));
  assert.ok(body.includes('# Before'));assert.ok(body.includes('## After'));
  assert.equal(normalizeProductMarkup(body),body);
});

test("list preserves direct non-li explanatory paragraphs, image and anchors in source order",()=>{
  const body=htmlToStructuredMarkdown('<h1>Steps</h1><ol><li>First</li><p class="note"><a name="original-note"></a>Note <a href="detail.htm">detail</a><img src="dialog.png"></p><li>Second<ul><li>Nested</li><p id="nested-note">Nested note</p></ul></li></ol>').markdown;
  assert.match(body,/1\. First/);assert.match(body,/2\. Second/);
  for(const part of ['<a id="original-note"></a>','[detail](detail.htm)','![](dialog.png)','<a id="nested-note"></a>'])assert.ok(body.includes(part));
  assert.ok(body.indexOf('First')<body.indexOf('original-note'));assert.ok(body.indexOf('original-note')<body.indexOf('Second'));
  assert.equal(normalizeProductMarkup(body),body);
});

test("nested lists with code preserve block boundaries and exact code without unmatched fences",()=>{
  const body=htmlToStructuredMarkdown('<h1>Before</h1><ul><li>Outer<ul><li>Inner<pre>  exact  <br>next</pre></li></ul></li></ul><h2>After</h2>').markdown;
  assert.match(body,/<ul data-relay-structure="ul">/);
  assert.match(body,/<pre>  exact  <br>next<\/pre>/);
  assert.ok(body.includes('## After'));assert.equal(normalizeProductMarkup(body),body);
});

test("HTML importer preserves source anchors, linked headings, cell relationships and images",()=>{
  const raw='<html><head><meta name="AIT_Topic_ID" content="42"></head><body><nav><a href="nav.htm">Navigation</a></nav><h1 id="original-title">Guide <a href="intro.htm#original">link</a></h1><section id="section-original"><p id="paragraph-original">See <a href="other.htm#part"><strong>other</strong></a>.</p><table id="table-original"><tr><th>A</th><th>B</th></tr><tr id="row-original"><td><a href="cell.htm">Cell</a></td><td><img src="screen.png" alt="screen"></td></tr></table></section></body></html>';
  const value=parseHelpHtml(raw);
  assert.match(value.text,/# Guide \[link\]\(intro.htm#original\)/);
  for(const id of ['original-title','section-original','paragraph-original','table-original','row-original'])assert.match(value.text,new RegExp(`<a id="${id}"></a>`));
  assert.match(value.text,/\| A \| B \|\n\| --- \| --- \|/);
  assert.match(value.text,/\| .*\[Cell\]\(cell.htm\).* \| !\[screen\]\(screen.png\) \|/);
  assert.deepEqual(value.images,['screen.png']);assert.ok(value.links.includes('other.htm#part'));assert.ok(!value.links.includes('nav.htm'));
  assert.equal(value.stableIdentifiers.ait_topic_id,'42');assert.ok(!value.text.includes('Navigation'));
  assert.equal(normalizeProductMarkup(value.text),value.text);
});

test("HTML pre blocks retain decoded exact code including line-end spaces, blank lines and nested backticks",()=>{
  const code='  &lt;Node value="x"&gt;  \n\n\n    ````literal```` &amp; data  \n  &lt;/Node&gt;  ';
  const expected='  <Node value="x">  \n\n\n    ````literal```` & data  \n  </Node>  ';
  const body=parseHelpHtml('<h1>Code</h1><pre class="language-xml"><code>'+code+'</code></pre>').text;
  assert.ok(body.includes(expected));assert.match(body,/`{5}xml\n/);assert.equal(normalizeProductMarkup(body),body);
});

test("safe complex HTML tables retain spans, nested tables and references across repeated normalization",()=>{
  const raw='<h1 id="heading">Complex</h1><table id="matrix"><tr><th colspan="2">Grouped</th></tr><tr><td rowspan="2"><a href="ref.htm#r">Ref</a><ul><li>First</li><li>Second</li></ul></td><td><table><tr><td><img src="inner.png"></td></tr></table></td></tr><tr><td>Last</td></tr></table><pre> exact  \n\n lines </pre>';
  const body=htmlToStructuredMarkdown(raw).markdown;
  assert.match(body,/<table/);assert.match(body,/colspan="2"/);assert.match(body,/rowspan="2"/);assert.match(body,/href="ref.htm#r"/);assert.match(body,/src="inner.png"/);
  assert.match(body,/<ul><li>First<\/li><li>Second<\/li><\/ul>/);
  assert.equal(normalizeProductMarkup(body),body);assert.equal(normalizeProductMarkup(normalizeProductMarkup(body)),body);
});

test("MadCap chrome is excluded while Innovasys headings and inline references survive",()=>{
  const body=parseHelpHtml('<head><script>secret()</script></head><div class="title-bar-container">Toolbar</div><div class="body-container"><div class="i-page-title-text" id="main">Main <em>topic</em></div><div class="i-section-heading"><span class="i-section-heading-text">Details</span></div><p><a name="part"></a>Read <a href="guide.htm">guide</a></p><img src="../GlobalStyles/Images-CSS-Skin/logo.png"><img src="../Resources/screenshot.png"></div>').text;
  assert.match(body,/# Main \*topic\*/);assert.match(body,/## Details/);assert.match(body,/<a id="part"><\/a>/);assert.match(body,/\[guide\]\(guide.htm\)/);
  assert.ok(!body.includes('secret()'));assert.ok(!body.includes('Toolbar'));assert.ok(!body.includes('logo.png'));assert.ok(body.includes('screenshot.png'));
});

test("line breaks and paragraphs inside table cells remain stable in mixed Markdown",()=>{
  const body=htmlToStructuredMarkdown('<h1>Cells</h1><p>Before</p><table><tr><td>First<br>Second</td><td><p>One</p><p>Two <code>a|b</code></p></td></tr></table><p>After</p>').markdown;
  assert.match(body,/<br>/);assert.match(body,/<p>One<\/p><p>Two <code>a\|b<\/code><\/p>/);
  assert.equal(normalizeProductMarkup(body),body);
});

test("static HTML conversion never preserves active attributes or dangerous destinations",()=>{
  const body=htmlToStructuredMarkdown('<h1 onclick="steal()">Safe</h1><script>steal()</script><a href="javascript:steal()">label</a><img src="data:image/svg+xml,evil" onerror="steal()"><table><tr><td colspan="2" onclick="steal()"><a href="https://example.test/ok">OK</a><iframe src="https://evil.test"></iframe></td></tr></table>').markdown;
  assert.doesNotMatch(body,/steal|javascript:|data:image|onclick|onerror|iframe/);assert.match(body,/https:\/\/example.test\/ok/);
  assert.equal(normalizeProductMarkup(body),body);
});

test("plain Markdown and literal HTML/code remain unchanged while legacy replay keeps the old parser",()=>{
  const markdown='# Existing\n\n```xml\n<Root>  \n\n\n</Root>\n```\n\n[link](other.htm#part)\n\n| A | B |\n| --- | --- |\n| one | two |\n\n<a id="old-anchor"></a>';
  assert.equal(normalizeProductMarkup(markdown),markdown);
  const raw='<h1 id="old">Title</h1><p><a href="page.htm">link</a></p><table><tr><td>one</td><td>two</td></tr></table>';
  assert.equal(legacyProductMarkupForReplay(raw),'<a id="old"></a>\n# Title\n\n[link](page.htm)\n\n|   |   |\n| --- | --- |\n| one | two |');
});
