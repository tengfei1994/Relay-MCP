/** Nonproduction probe; use an explicitly authorized existing Session/Evidence. */
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

async function main() {
  const base=process.env.RELAY_CANDIDATE_ASYNC_URL?.replace(/\/+$/, "");
  const token=process.env.RELAY_CANDIDATE_ASYNC_TOKEN,requestPath=process.env.RELAY_CANDIDATE_ASYNC_REQUEST;
  if(!base||!token||!requestPath)throw new Error("Set RELAY_CANDIDATE_ASYNC_URL, RELAY_CANDIDATE_ASYNC_TOKEN and RELAY_CANDIDATE_ASYNC_REQUEST");
  const url=new URL(base);
  if(!["127.0.0.1","localhost","[::1]"].includes(url.hostname))throw new Error("Run the nonproduction probe on its host using a loopback URL");
  const input=JSON.parse(readFileSync(requestPath,"utf8"));
  if(!input.sessionId||!input.providerId||!Array.isArray(input.evidenceRefs)||!input.evidenceRefs.length)throw new Error("Request file requires an authorized sessionId, providerId and nonempty evidenceRefs");
  const body={sessionId:input.sessionId,providerId:input.providerId,evidenceRefs:input.evidenceRefs,context:input.context??{},async:true};
  const api=async(path:string,payload?:unknown)=>{
    const response=await fetch(base+path,{method:payload===undefined?"GET":"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:payload===undefined?undefined:JSON.stringify(payload),signal:AbortSignal.timeout(30_000),redirect:"error"});
    if(!response.ok)throw new Error(`Candidate async probe HTTP ${response.status}`);
    return {status:response.status,value:await response.json() as any};
  };
  const first=await api("/api/knowledge/candidate-insights/compile",body);
  assert.equal(first.status,202);
  const replay=await api("/api/knowledge/candidate-insights/compile",body);
  assert.equal(replay.value.job.id,first.value.job.id);assert.equal(replay.value.enqueued,false);
  const started=Date.now(),budget=Number(process.env.RELAY_CANDIDATE_ASYNC_TIMEOUT_MS??180_000);
  if(!Number.isFinite(budget)||budget<1000||budget>1_800_000)throw new Error("Invalid probe timeout");
  let job=first.value.job;
  while(!["done","failed"].includes(job.status)&&Date.now()-started<budget){
    await new Promise(resolve=>setTimeout(resolve,500));
    job=(await api(`/api/knowledge/candidate-insight-jobs/${encodeURIComponent(job.id)}`)).value.job;
  }
  assert.equal(job.status,"done","Candidate job did not complete successfully");assert.ok(job.insightId);
  const insight=(await api(`/api/knowledge/candidate-insights/${encodeURIComponent(job.insightId)}`)).value.insight;
  assert.equal(insight.status,"draft");assert.equal(insight.promotion,undefined);assert.equal(insight.fallbackReason,undefined);
  assert.ok(insight.generatedBy.startsWith(`managed-candidate-llm:${input.providerId}/`));
  assert.deepEqual([...insight.evidenceRefs].sort(),[...new Set(input.evidenceRefs)].sort());
  const finalReplay=(await api("/api/knowledge/candidate-insights/compile",body)).value.job;
  assert.equal(finalReplay.id,job.id);assert.equal(finalReplay.attempts,job.attempts);
  const report={ok:true,jobId:job.id,insightId:insight.id,status:job.status,attempts:job.attempts,generatedBy:insight.generatedBy,evidenceCount:insight.evidenceRefs.length};
  if(process.env.RELAY_CANDIDATE_ASYNC_REPORT)writeFileSync(process.env.RELAY_CANDIDATE_ASYNC_REPORT,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
main().catch(()=>{console.error("Candidate async live probe failed; inspect job status through the authenticated API");process.exitCode=1;});
