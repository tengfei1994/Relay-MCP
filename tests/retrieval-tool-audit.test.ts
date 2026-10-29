import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {sanitizeAuditArguments} from "../src/shared/audit-sanitizer.ts";
import {sanitizeToolAuditArguments} from "../src/shared/retrieval-audit.ts";

test("MCP retrieval and diagnostic audit projects query hashes and scopes without raw arguments",()=>{
 const input={query:"private_query_sentinel",project:"p1",environment:"nonprod",workSessionId:"session-1",limit:10,body:"private_body_sentinel",extra:{snippet:"private_extra_sentinel"},formName:"private_unselected_metadata"};
 const before=structuredClone(input);
 for(const tool of ["memory_search","knowledge_search","knowledge_source_search","knowledge_wiki_search","samplemanager_diagnose"]){
  const projected=sanitizeToolAuditArguments(tool,input) as any,stored=sanitizeAuditArguments(projected);
  assert.doesNotMatch(JSON.stringify(stored),/private_query|private_body|private_extra|private_unselected/);
  assert.equal(projected.queryHash,createHash("sha256").update(input.query).digest("hex"));assert.equal(projected.queryLength,input.query.length);assert.equal(projected.project,"p1");assert.equal(projected.environment,"nonprod");assert.equal(projected.workSessionId,"session-1");assert.equal(projected.limit,10);assert.equal(projected.extra,undefined);
 }
 assert.deepEqual(input,before);
});

test("MCP retrieval audit accepts omitted or malformed optional arguments without echoing them",()=>{
 for(const input of [undefined,null,"private_raw_argument",["private_array_argument"],{query:{text:"private_nested_query"}}])assert.doesNotMatch(JSON.stringify(sanitizeToolAuditArguments("knowledge_wiki_search",input)) ?? "",/private_/);
});

test("non-retrieval tools retain the existing audit sanitizer contract",()=>{
 const input={project:"p1",query:"ordinary non-retrieval metadata",token:"private_credential",environmentVariables:{FLAG:"private_value"}};
 assert.deepEqual(sanitizeToolAuditArguments("unrelated_tool",input),sanitizeAuditArguments(input));
});
