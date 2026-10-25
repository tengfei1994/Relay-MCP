import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import {safeRequestLogSerializers,safeRequestLogHooks,sendSafeNotFound,requestLogSerializer} from "../src/server/request-log.ts";
async function capture(fn:(url:string,logs:()=>string)=>Promise<void>){
 let output="";const app=Fastify({logger:{stream:{write(line:string){output+=line;}},serializers:safeRequestLogSerializers,hooks:safeRequestLogHooks}});
 app.post("/api/knowledge/search",async request=>({query:request.query,body:request.body,url:request.url,header:request.headers["x-private"]}));
 app.setNotFoundHandler((_request,reply)=>sendSafeNotFound(reply));
 try{const url=await app.listen({host:"127.0.0.1",port:0});await fn(url,()=>output);}finally{await app.close();}
}

test("real HTTP request logs exclude query headers and body while handlers retain the original request",()=>capture(async(url,logs)=>{
 const path="/api/knowledge/search?q=private_query_sentinel&token=private_url_token",body={query:"private_body_sentinel"};
 const response=await fetch(url+path,{method:"POST",headers:{"content-type":"application/json","x-private":"private_header_sentinel"},body:JSON.stringify(body)});
 const result=await response.json() as any;assert.equal(response.status,200);assert.equal(result.query.q,"private_query_sentinel");assert.equal(result.url,path);assert.deepEqual(result.body,body);assert.equal(result.header,"private_header_sentinel");
 assert.doesNotMatch(logs(),/private_query_sentinel|private_url_token|private_body_sentinel|private_header_sentinel/);
 const request=logs().trim().split("\n").map(line=>JSON.parse(line)).find(line=>line.req)?.req;assert.equal(request.method,"POST");assert.equal(request.path,"/api/knowledge/search");assert.equal(request.headers,undefined);assert.equal(request.body,undefined);assert.equal(request.url,undefined);
}));

test("unknown routes do not leak query strings through Fastify's default 404 log message",()=>capture(async(url,logs)=>{
 const response=await fetch(url+"/missing?q=private_unknown_sentinel");assert.equal(response.status,404);await response.text();assert.doesNotMatch(logs(),/private_unknown_sentinel/);
}));


test("request serializer never reads content-bearing properties and removes absolute URL credentials",()=>{
 const request={method:"GET",url:"http://private_user:private_password@host.test/path?q=private_query#private_fragment",ip:"127.0.0.1",raw:{socket:{remotePort:1234}},get headers(){throw new Error("headers must not be read");},get body(){throw new Error("body must not be read");}};
 assert.deepEqual(requestLogSerializer(request as any),{method:"GET",path:"/path",remoteAddress:"127.0.0.1",remotePort:1234});
});

test("malformed JSON cannot leak even a truncated body prefix through error messages or stacks",()=>capture(async(url,logs)=>{
 const response=await fetch(url+"/api/knowledge/search",{method:"POST",headers:{"content-type":"application/json"},body:"private_body_sentinel"});assert.equal(response.status,400);await response.text();
 assert.doesNotMatch(logs(),/private_/);
 const error=logs().trim().split("\n").map(line=>JSON.parse(line)).find(line=>line.err)?.err;assert.ok(error);assert.equal(error.type,"SyntaxError");assert.equal(error.statusCode,400);assert.equal(error.message,undefined);assert.equal(error.stack,undefined);
}));
