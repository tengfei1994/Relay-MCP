import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {KnowledgeMarkup} from '../frontend/src/components/KnowledgeMarkup.tsx';
import {api} from '../frontend/src/api/client.ts';
const requireFrontend=createRequire(new URL('../frontend/package.json',import.meta.url));
const React=requireFrontend('react');
const {renderToStaticMarkup}=requireFrontend('react-dom/server');
const {StaticRouter}=requireFrontend('react-router-dom/server');
const render=(source:string, wikiScope:any={projectId:'project-a',environment:'test'})=>renderToStaticMarkup(React.createElement(StaticRouter,null,React.createElement(KnowledgeMarkup,{source,wikiScope,wikiPageKey:'engine-wiki:0123456789abcdef:entity/current'})));

test('generated Wiki labels and bare slugs navigate within the current Relay scope',()=>{
 const html=render('See [[entity/samplemanager-pims|SampleManager PIMS]] and [[concept/pims-configuration-items]].');
 assert.match(html,/href="\/knowledge\/integrated\?tab=wiki&amp;wikiKey=engine-wiki%3A0123456789abcdef%3Aentity%2Fsamplemanager-pims&amp;projectId=project-a&amp;environment=test"/);
 assert.match(html,/>SampleManager PIMS<\/a>/);
 assert.match(html,/>concept\/pims-configuration-items<\/a>/);
 assert.doesNotMatch(html,/target="_blank"/);
});

test('Wiki rendering leaves code, existing links and raw HTML text alone',()=>{
 const html=render('`[[entity/code]]`\n\n```text\n[[entity/fenced]]\n```\n\n<pre>[[entity/raw]]</pre>\n\n[Original [[entity/existing]]](https://example.test)');
 assert.doesNotMatch(html,/wikiKey=/);
 assert.match(html,/\[\[entity\/code\]\]/); assert.match(html,/\[\[entity\/fenced\]\]/); assert.match(html,/\[\[entity\/raw\]\]/);
 assert.match(html,/href="https:\/\/example.test"/);
});

test('Wiki links cannot carry external URLs, traversal, encoded paths, query scope overrides or missing project scope',()=>{
 const html=render('[[https://evil.test/x|external]] [[https://evil.test/x|label with spaces]] [[//evil.test/x]] [[../entity/x]] [[entity/%2e%2e/x]] [[entity/x?projectId=other]] [[entity/x#part]] [[entity\\x]]');
 assert.doesNotMatch(html,/<a\b/);
 assert.doesNotMatch(render('[[entity/safe]]',{}),/<a\b/);
});

test('Wiki resolver sends full bound key and only the caller current scope to Relay',async()=>{
 const previousFetch=globalThis.fetch,previousStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>null}});
 let called='';globalThis.fetch=async(url)=>{called=String(url);return new Response('{}',{status:200});};
 try {
  const pageKey='engine-wiki:0123456789abcdef:entity/samplemanager-pims';
  await api.knowledgeWikiResolve(pageKey,{projectId:'current-project',environment:'test'});
  const url=new URL(called,'http://relay.test');
  assert.equal(url.pathname,'/api/knowledge/wiki/resolve');assert.equal(url.searchParams.get('pageKey'),pageKey);
  assert.equal(url.searchParams.get('projectId'),'current-project');assert.equal(url.searchParams.get('environment'),'test');
  assert.deepEqual([...url.searchParams.keys()],['pageKey','projectId','environment']);
 } finally {
  globalThis.fetch=previousFetch;if(previousStorage)Object.defineProperty(globalThis,'localStorage',previousStorage);else delete (globalThis as any).localStorage;
 }
});

test('ordinary source readers retain literal bracket references without a Wiki context',()=>{
 const html=renderToStaticMarkup(React.createElement(KnowledgeMarkup,{source:'[[entity/literal|Literal]]'}));
 assert.match(html,/\[\[entity\/literal\|Literal\]\]/);
});
