import {existsSync,readFileSync,writeFileSync,renameSync,chmodSync,unlinkSync} from "node:fs";
import {join,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import type {EngineModelBinding} from "./engine-model-gateway.js";
export interface EngineRuntimeConfig {
  schemaVersion:1;version:string;baseUrl:string;relayGatewayUrl:string;gatewayToken:string;
  ownerEmail:string;ownerPassword:string;
}
export interface EngineControlState {
  phase?:"initializing"|"ready"|"failed";
  ingestionProfile?:"standard"|"bulk";
  schemaVersion:1;apiKey?:string;tenantId?:string|number;knowledgeBaseId?:string;
  bindings:EngineModelBinding[];updatedAt?:string;
}
export class EngineError extends Error {constructor(readonly code:string,readonly status=503){super(code);}}
export function engineHome():string {return resolve(process.env.KNOWLEDGE_ENGINE_HOME??join(process.cwd(),"runtime","knowledge-engine"));}
function loopbackUrl(value:string):string {
  let url:URL;try{url=new URL(value);}catch{throw new EngineError("engine_config_invalid");}
  if(!["http:","https:"].includes(url.protocol)||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw new EngineError("engine_must_use_loopback");
  return value.replace(/\/+$/,"");
}
export function readEngineRuntime(home=engineHome()):EngineRuntimeConfig|undefined {
  const file=join(home,"engine.json");if(!existsSync(file))return undefined;
  try {
    const c=JSON.parse(readFileSync(file,"utf8")) as EngineRuntimeConfig;
    if(c.schemaVersion!==1||!c.gatewayToken||!c.ownerEmail||!c.ownerPassword)throw new EngineError("engine_config_invalid");
    c.baseUrl=loopbackUrl(c.baseUrl);c.relayGatewayUrl=loopbackUrl(c.relayGatewayUrl);return c;
  }catch(error){if(error instanceof EngineError)throw error;throw new EngineError("engine_config_invalid");}
}
export function readEngineControl(home=engineHome()):EngineControlState {
  const file=join(home,"control.json");if(!existsSync(file))return {schemaVersion:1,bindings:[]};
  try{const state=JSON.parse(readFileSync(file,"utf8"));if(state.schemaVersion!==1||!Array.isArray(state.bindings))throw new Error();return state;}
  catch{throw new EngineError("engine_control_invalid");}
}
export function writeEngineControl(home:string,state:EngineControlState):void {
  const file=join(home,"control.json"),temp=file+"."+randomUUID()+".tmp";
  try {writeFileSync(temp,JSON.stringify({...state,updatedAt:new Date().toISOString()}),{mode:0o600,flag:"wx"});chmodSync(temp,0o600);renameSync(temp,file);}
  finally{if(existsSync(temp))unlinkSync(temp);}
}
