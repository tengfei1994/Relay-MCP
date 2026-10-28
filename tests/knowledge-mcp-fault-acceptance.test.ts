import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawn} from "node:child_process";

test("real isolated HTTP and MCP fault packet rejects malformed data and recovers without models",{timeout:60_000},async()=>{
 const root=mkdtempSync(join(tmpdir(),"fault-acceptance-test-")),report=join(root,"report.json");
 try {
  const execution=await new Promise<{code:number|null,output:string}>(resolve=>{const child=spawn(process.execPath,["--import","tsx","scripts/knowledge-mcp-fault-acceptance.ts","--faults","rate_limited,invalid_json,invalid_ref","--report",report],{stdio:["ignore","pipe","pipe"],env:{...process.env}});let output="";child.stdout.on("data",x=>output+=x);child.stderr.on("data",x=>output+=x);child.on("close",code=>resolve({code,output}));});
  assert.equal(execution.code,0,execution.output);
  const result=JSON.parse(readFileSync(report,"utf8"));
  assert.equal(result.status,"passed_injected_transport_faults");assert.equal(result.injectedFaults,true);assert.equal(result.modelCalls,0);assert.equal(result.providersConfigured,0);assert.equal(result.activeJobs,0);
  assert.deepEqual(result.scenarios.map((x:any)=>x.fault),["rate_limited","invalid_json","invalid_ref"]);
  for(const row of result.scenarios){assert.equal(row.recovery,"passed");assert.equal(row.memoryAvailable,true);assert.equal(row.upstreamRequests,2);}
  assert.ok(result.counts.faultHttp>=14);assert.ok(result.counts.relayHttp>0);assert.ok(result.counts.mcpHttp>0);assert.equal(result.privacy.canaryMatches,0);assert.equal(result.acl.deniedWithoutUpstream,true);assert.equal(result.restart.recovery,"passed");assert.equal(result.restart.degradedCode,"unavailable");assert.equal(result.restart.memoryAvailable,true);
 } finally {rmSync(root,{recursive:true,force:true});}
});
