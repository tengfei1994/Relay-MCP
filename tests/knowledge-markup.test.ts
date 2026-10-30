import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {KnowledgeMarkup} from '../frontend/src/components/KnowledgeMarkup.tsx';
const requireFrontend=createRequire(new URL('../frontend/package.json',import.meta.url));
const React=requireFrontend('react');
const {renderToStaticMarkup}=requireFrontend('react-dom/server');
const render=(source:string)=>renderToStaticMarkup(React.createElement(KnowledgeMarkup,{source}));

test('knowledge reader renders table relationships and exact code whitespace',()=>{
 const html=render('# Guide\n\n| First | Second |\n| --- | --- |\n| A | B |\n\n```xml\n  <Node>  \n\n\n  </Node>\n```');
 assert.match(html,/<h1 id="knowledge-content-guide">Guide<\/h1>/);assert.match(html,/<th[^>]*>First<\/th>/);assert.match(html,/<td[^>]*>B<\/td>/);
 assert.ok(html.includes('  &lt;Node&gt;  \n\n\n  &lt;/Node&gt;\n'));
});
test('knowledge reader preserves sanitized complex structures and source anchors',()=>{
 const html=render('<a id="original"></a>\n\n[Jump](#original)\n\n<table><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table>');
 assert.match(html,/id="knowledge-content-original"/);assert.match(html,/href="#knowledge-content-original"/);assert.match(html,/rowSpan="2"|rowspan="2"/);
});
test('knowledge reader blocks active markup and automatic external image requests',()=>{
 const html=render('<script>alert(1)</script><img src="https://external.test/track.png" onerror="steal()"><a href="javascript:steal()">Unsafe</a><iframe src="https://external.test"></iframe>\n\n[Source](guide.htm#part)');
 assert.doesNotMatch(html,/<script|<iframe|<img|onerror|javascript:|steal\(/i);
 assert.match(html,/Image reference/);assert.ok(html.includes('guide.htm#part'));
 assert.doesNotMatch(html,/href="guide.htm/);
});
test('canonical code references do not change copyable code and retain named/cell anchors',()=>{
 const html=render('<pre>first<br><a name="original" href="keyword.htm#original">second</a><br>third</pre><table><tr><td id="cell">Value</td></tr></table>\n\n[Jump](#cell)');
 const pre=html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)![1];
 assert.doesNotMatch(pre,/\(keyword\.htm/);
 assert.match(html,/id="knowledge-content-original"/);assert.match(html,/id="knowledge-content-cell"/);
 assert.match(html,/Source references/);assert.match(html,/keyword\.htm#original/);
});
