import assert from "node:assert/strict";
import test from "node:test";
import {parseHelpHtml} from "../src/knowledge/parsers.ts";
import {normalizeProductMarkup,legacyProductMarkupForReplay} from "../src/knowledge/weknora-markdown.ts";

test("normalization preserves angle-delimited Markdown links and images",()=>{
  const body='# Topic\n\n[Feedback](<mailto:docs@example.test?subject=Example Topic>)\n\n[Related](<Database Commands/General.html#section>)\n\n![Screen](<images/dialog (large).png> "Screen title")';
  assert.equal(normalizeProductMarkup(body),body);
  assert.equal(normalizeProductMarkup(normalizeProductMarkup(body)),body);
});

test("HTML-derived spaced destinations survive table, heading and trailing content normalization",()=>{
  const source='<h1 id="topic">Topic <a href="Related Topics.html">related</a></h1><table><tr><th>Property</th><th>Value</th></tr><tr><td><a href="Value Details.html#part">value</a></td><td><img src="images/dialog large.png" alt="screen"></td></tr></table><pre>first  \nsecond &lt;node&gt;</pre><p>After code</p><a href="mailto:docs@example.test?subject=Topic Feedback">Feedback</a>';
  const parsed=parseHelpHtml(source);
  assert.ok(parsed.text.includes('[related](<Related Topics.html>)'));
  assert.ok(parsed.text.includes('![screen](<images/dialog large.png>)'));
  assert.equal(normalizeProductMarkup(parsed.text),parsed.text);
  assert.ok(normalizeProductMarkup(parsed.text).includes('first  \nsecond <node>'));
});

test("angle-destination handling preserves code literals and existing HTML cleanup",()=>{
  const code='```text\n[raw](<a b>)\n```';
  assert.equal(normalizeProductMarkup(code),code);
  assert.equal(normalizeProductMarkup('[related](<a b>)\n<custom>text</custom>'),'[related](<a b>)\ntext');
  assert.equal(normalizeProductMarkup('<p>Text<script>alert(1)</script></p>'),'Text');
  assert.equal(legacyProductMarkupForReplay('[Feedback](<mailto:docs@example.test?subject=Example Topic>)'),'[Feedback]()');
});

test("destination masking cannot bypass canonical HTML attribute sanitization",()=>{
  const source='<table data-relay-structure="table"><tr><td>](<img src="image.png" onerror="alert(1)">)</td></tr></table>';
  assert.doesNotMatch(normalizeProductMarkup(source),/onerror|alert\(1\)/);
});
