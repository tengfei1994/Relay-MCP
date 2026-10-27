import { CandidateInsightCompiler } from "./candidate-insight.js";
import { CandidateInsightWorker, type CandidateInsightJob } from "./candidate-worker.js";
import { createCandidateInsightProvider } from "./candidate-provider.js";
import type { KnowledgeStore } from "./store.js";

function compilerForJob(store: KnowledgeStore, job: CandidateInsightJob): CandidateInsightCompiler {
  return new CandidateInsightCompiler(store,createCandidateInsightProvider(store,job.providerId));
}

/** A separate async consumer lane; no model call runs on capture/ingest handlers. */
export function startCandidateInsightDispatcher(getStore:()=>KnowledgeStore|undefined, options:{intervalMs?:number;onError?:()=>void}={}) {
  let stopping=false,worker:CandidateInsightWorker|undefined,current:KnowledgeStore|undefined,cycle:Promise<void>|undefined;
  const tick=()=>{
    if(stopping||cycle)return;
    const store=getStore();if(!store?.db.open)return;
    if(current!==store){current=store;worker=new CandidateInsightWorker(store,job=>compilerForJob(store,job));}
    cycle=worker!.runOnce(5).then(()=>undefined).catch(()=>{options.onError?.();}).finally(()=>{cycle=undefined;});
  };
  const timer=setInterval(tick,Math.max(25,Math.min(60_000,options.intervalMs??1000)));
  timer.unref?.();queueMicrotask(tick);
  return {async stop(){stopping=true;clearInterval(timer);await worker?.stop();await cycle;}};
}
