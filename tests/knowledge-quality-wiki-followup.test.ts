import test from 'node:test';
import assert from 'node:assert/strict';
import {sha} from '../scripts/knowledge-quality-common.ts';
import {buildFollowupPlan,validateFollowup} from '../scripts/knowledge-quality-wiki-followup.ts';
import type {FrozenWikiPage} from '../scripts/knowledge-quality-wiki-review.ts';
const content='Setting | Meaning\n--- | ---\nReview | Requires confirmation.\n\nIt does not submit a result.';
const page:FrozenWikiPage={id:'page',revision:1,body:'# Heading\n\nReview requires confirmation.\n\nReview also sends email.',citationSha256:'citation',guardSha256:'guard',flags:[],sources:[{mappingId:'map',rawSha256:'raw',normalizedSha256:'normalized',chunks:[{id:'chunk',content,sha256:sha(content)}]}]};
function response(plan:ReturnType<typeof buildFollowupPlan>){const span=plan.spans[0];return {paragraphs:plan.paragraphs.map((p,i)=>({id:p.id,classification:i===0?'nonfactual':i===1?'supported':'insufficient',reason:i===0?'Heading only.':i===1?'Source explicitly requires confirmation.':'Email behavior is not asserted.',reasonCode:i===0?'no_factual_claim':i===1?'source_asserts':'source_does_not_assert',claims:i===0?[]:[{text:i===1?'Review requires confirmation.':'Review sends email.',classification:i===1?'supported':'insufficient',evidence:i===1?[{spanId:span.id,sha256:span.sha256}]:[]}]}))};}
test('followup keeps complete context and extracts exact frozen spans instead of rewritten quotes',()=>{
 const plan=buildFollowupPlan(page);assert.equal(plan.eligible,true);assert.ok(plan.prompt.includes(JSON.stringify(content)));assert.equal(plan.paragraphs.length,3);assert.ok(plan.prompt.includes('untrusted'));assert.ok(plan.prompt.includes('not a chain of thought'));
 assert.equal(plan.spans.map(s=>s.text).join(''),content);
 const result=validateFollowup(plan,JSON.stringify(response(plan)),'stop');assert.equal(result.complete,true);assert.equal(result.paragraphs[1].evidence[0].quote,plan.spans[0].text);assert.equal(result.paragraphs[2].classification,'insufficient');
});
test('foreign IDs, wrong hashes and model-provided rewritten quotes cannot become accepted evidence',()=>{
 const plan=buildFollowupPlan(page);
 for(const change of [{spanId:'foreign'}, {sha256:'wrong'}, {quote:'flattened table text'}]){const rows=response(plan);Object.assign(rows.paragraphs[1].claims[0].evidence[0],change);assert.equal(validateFollowup(plan,JSON.stringify(rows),'stop').complete,false);}
});
test('mixed claims cannot be supported or hidden as nonfactual; coverage and JSON remain fail closed',()=>{
 const plan=buildFollowupPlan(page),rows=response(plan);rows.paragraphs[1].claims.push({text:'Unknown additional behavior.',classification:'insufficient',evidence:[]});assert.equal(validateFollowup(plan,JSON.stringify(rows),'stop').complete,false);
 rows.paragraphs[1].classification='nonfactual';assert.equal(validateFollowup(plan,JSON.stringify(rows),'stop').complete,false);
 assert.equal(validateFollowup(plan,JSON.stringify({paragraphs:response(plan).paragraphs.slice(1)}),'stop').complete,false);
 const repeated=response(plan);repeated.paragraphs.push(repeated.paragraphs[0]);assert.equal(validateFollowup(plan,JSON.stringify(repeated),'stop').complete,false);
 assert.equal(validateFollowup(plan,JSON.stringify(response(plan)),'length').complete,false);assert.equal(validateFollowup(plan,'{"paragraphs":[]}}','stop').complete,false);
});
test('no truncation or mutable source proof is accepted and brief reason is mandatory',()=>{
 const huge=buildFollowupPlan({...page,sources:[{...page.sources[0],chunks:[{id:'large',content:'x'.repeat(100000),sha256:sha('x'.repeat(100000))}]}]});assert.equal(huge.eligible,false);assert.ok(huge.prompt.includes('x'.repeat(100000)));
 assert.equal(buildFollowupPlan({...page,sources:[{...page.sources[0],chunks:[{id:'chunk',content,sha256:'wrong'}]}]}).eligible,false);
 const plan=buildFollowupPlan(page),rows=response(plan);rows.paragraphs[1].reason='';assert.equal(validateFollowup(plan,JSON.stringify(rows),'stop').complete,false);
});
test('finite long evidence explanations retain complete text with an explicitly truncated display preview',()=>{
 const plan=buildFollowupPlan(page),rows=response(plan);rows.paragraphs[1].reason='Evidence explanation. '.repeat(40);
 const checked=validateFollowup(plan,JSON.stringify(rows),'stop');assert.equal(checked.complete,true);assert.equal(checked.paragraphs[1].reason,rows.paragraphs[1].reason);
 assert.equal(checked.paragraphs[1].reasonPreview.length,500);assert.equal(checked.paragraphs[1].reasonPreviewTruncated,true);assert.equal(checked.paragraphs[1].evidence[0].quote,plan.spans[0].text);
 rows.paragraphs[1].reason='x'.repeat(4097);assert.equal(validateFollowup(plan,JSON.stringify(rows),'stop').complete,false);
 rows.paragraphs[1].reason='Evidence explanation. '.repeat(40);rows.paragraphs[1].claims[0].evidence[0].sha256='wrong';assert.equal(validateFollowup(plan,JSON.stringify(rows),'stop').complete,false);
});

test('valid review coverage never becomes source-support pass while factual claims remain unresolved',()=>{
 const plan=buildFollowupPlan(page);
 const checked=validateFollowup(plan,JSON.stringify(response(plan)),'stop');
 assert.equal(checked.complete,true);
 assert.equal(checked.sourceSupportPassed,false);
 const supportedPlan=buildFollowupPlan({...page,body:'# Heading\n\nReview requires confirmation.'});
 const supported=validateFollowup(supportedPlan,JSON.stringify(response(supportedPlan)),'stop');
 assert.equal(supported.complete,true);
 assert.equal(supported.sourceSupportPassed,true);
 const headingPlan=buildFollowupPlan({...page,body:'# Heading'});
 assert.equal(validateFollowup(headingPlan,JSON.stringify(response(headingPlan)),'stop').sourceSupportPassed,false);
 const invalid=response(supportedPlan);invalid.paragraphs[1].claims[0].evidence[0].sha256='wrong';
 assert.equal(validateFollowup(supportedPlan,JSON.stringify(invalid),'stop').sourceSupportPassed,false);
});
