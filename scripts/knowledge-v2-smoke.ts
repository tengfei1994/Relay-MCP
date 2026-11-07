/** Read-only smoke test for an operator-selected nonproduction MCP endpoint.
 * Supply credentials through a file; do not print queries, tokens or returned content. */
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const names=['knowledge_search','knowledge_get','memory_search','knowledge_confirmed_memory_get','memory_capture'];
const endpoint=process.env.KNOWLEDGE_V2_MCP_URL;
const tokenFile=process.env.KNOWLEDGE_V2_TOKEN_FILE;
const query=process.env.KNOWLEDGE_V2_QUERY;
if(process.argv.includes('--help')) {
 console.log('Set KNOWLEDGE_V2_MCP_URL, KNOWLEDGE_V2_TOKEN_FILE and KNOWLEDGE_V2_QUERY for an authorized nonproduction user. Optional: KNOWLEDGE_V2_PROJECT_ID. This performs read-only calls and prints counts only.');
} else {
 if(!endpoint||!tokenFile||!query?.trim()) throw new Error('Set KNOWLEDGE_V2_MCP_URL, KNOWLEDGE_V2_TOKEN_FILE and KNOWLEDGE_V2_QUERY');
 const url=new URL(endpoint);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid MCP endpoint');
 const token=(await readFile(tokenFile,'utf8')).trim();if(!token)throw new Error('MCP token file is empty');
 const client=new Client({name:'knowledge-v2-readonly-smoke',version:'1.0.0'});
 const result:{catalog:boolean;productChunks:number;documentRead:'passed'|'no-results';memories:number;memoryRead:'passed'|'no-results';projectScopeChecked:boolean}={catalog:false,productChunks:0,documentRead:'no-results',memories:0,memoryRead:'no-results',projectScopeChecked:false};
 const parse=async(name:string,args:Record<string,unknown>)=>{
  const response:any=await client.callTool({name,arguments:args});
  if(response.isError)throw new Error(name+' failed; check the service and this user’s permissions');
  const text=response.content?.filter((item:any)=>item.type==='text').map((item:any)=>item.text).join('\n');
  if(!text)throw new Error(name+' returned no JSON');return JSON.parse(text);
 };
 try {
  await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{authorization:'Bearer '+token}}}));
  const tools=(await client.listTools()).tools;
  const knowledge=tools.filter(tool=>tool.name.startsWith('knowledge_')||tool.name.startsWith('memory_')||['context_search','context_record_fact'].includes(tool.name));
  if(knowledge.length!==names.length||names.some(name=>!knowledge.some(tool=>tool.name===name)))throw new Error('Knowledge tool catalog differs from the five-tool contract');
  if(knowledge.find(tool=>tool.name==='memory_capture')?.annotations?.readOnlyHint!==false)throw new Error('memory_capture is not correctly marked as a write');
  result.catalog=true;
  const search=await parse('knowledge_search',{query,limit:10});
  if(!Array.isArray(search.references)||search.contextPack||search.references.some((ref:any)=>!ref.documentId||!ref.chunkId||!ref.citation))throw new Error('Product search response failed validation');
  result.productChunks=search.references.length;
  if(search.references.length){const ref=search.references[0];const document=await parse('knowledge_get',{documentId:ref.documentId,chunkId:ref.chunkId});if(document.documentId!==ref.documentId||document.chunkId!==ref.chunkId||typeof document.body!=='string')throw new Error('Product chunk identity mismatch');result.documentRead='passed';}
  const projectId=process.env.KNOWLEDGE_V2_PROJECT_ID;
  const memories=await parse('memory_search',projectId?{scope:'project',projectId,limit:10}:{scope:'general',limit:10});
  if(!Array.isArray(memories.results)||memories.results.some((memory:any)=>memory.status!=='confirmed'))throw new Error('Memory search returned an invalid result');
  result.projectScopeChecked=Boolean(projectId);result.memories=memories.results.length;
  if(memories.results.length){const memory=await parse('knowledge_confirmed_memory_get',{memoryId:memories.results[0].id});if(memory.memory?.id!==memories.results[0].id||memory.memory?.status!=='confirmed')throw new Error('Memory identity mismatch');result.memoryRead='passed';}
  console.log(JSON.stringify(result));
 } finally {await client.close();}
}
