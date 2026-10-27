import type { KnowledgeStore } from './store.js';
import type { WorkSession } from './work-session.js';

/** Preserve the owner Session contract; joined records expose references, never source content. */
export function summarizeWorkSession(store: KnowledgeStore, session: WorkSession, input: {limit?: number; offset?: number}) {
 const limit=Number.isFinite(input.limit)?Math.max(1,Math.min(200,Math.trunc(input.limit!))):50;
 const offset=Number.isFinite(input.offset)?Math.max(0,Math.min(1_000_000,Math.trunc(input.offset!))):0;
 const params={sessionId:session.id,actorId:session.actorId,projectId:session.projectId,environment:session.environment??''};
 // Keep standalone references written through the Session service. They cannot
 // confer access to joined content; those joins require authoritative source scope.
 const cte=`WITH scoped_domain_events AS (
  SELECT e.id AS event_id FROM knowledge_work_session_events s JOIN relay_domain_events e ON e.id=s.event_id
  WHERE s.session_id=@sessionId AND e.project_id=@projectId AND e.actor_id=@actorId
   AND json_extract(CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END,'$.workSessionId')=@sessionId
   AND COALESCE(json_extract(CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END,'$.environment'),json_extract(CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END,'$.env'),'')=@environment
 ), scoped_retrievals AS (
  SELECT r.id,r.created_at,r.degraded,
   CASE WHEN json_extract(CASE WHEN json_valid(r.results_json) THEN r.results_json ELSE '{}' END,'$.operation')='document_read' THEN 'document_read' ELSE 'search' END AS operation,
   CASE WHEN json_type(CASE WHEN json_valid(r.results_json) THEN r.results_json ELSE '{}' END,'$.resultCount')='integer'
    THEN MAX(0,json_extract(r.results_json,'$.resultCount')) ELSE 0 END AS resultCount
  FROM knowledge_retrieval_runs r JOIN knowledge_work_session_events s ON s.event_id=r.id AND s.event_type='knowledge.retrieval'
  WHERE s.session_id=@sessionId AND r.project_id=@projectId
   AND json_extract(CASE WHEN json_valid(r.results_json) THEN r.results_json ELSE '{}' END,'$.workSessionId')=@sessionId
   AND json_extract(CASE WHEN json_valid(r.results_json) THEN r.results_json ELSE '{}' END,'$.actorId')=@actorId
   AND COALESCE(json_extract(CASE WHEN json_valid(r.results_json) THEN r.results_json ELSE '{}' END,'$.environment'),'')=@environment
 ), scoped_events AS (
  SELECT s.id,s.event_id,s.event_type,s.intent_step,s.objective_ref,s.acceptance_criterion_ref,s.created_at,s.rowid AS sequence
  FROM knowledge_work_session_events s WHERE s.session_id=@sessionId AND (
   s.event_id IN(SELECT event_id FROM scoped_domain_events) OR s.event_id IN(SELECT id FROM scoped_retrievals)
   OR (s.event_type<>'knowledge.retrieval'
    AND NOT EXISTS(SELECT 1 FROM relay_domain_events e WHERE e.id=s.event_id)
    AND NOT EXISTS(SELECT 1 FROM knowledge_retrieval_runs r WHERE r.id=s.event_id)))
 ), scoped_observations AS (
  SELECT o.id,o.event_id,o.created_at FROM knowledge_observations o JOIN scoped_domain_events e ON e.event_id=o.event_id WHERE o.project_id=@projectId
 ), scoped_evidence AS (
  SELECT DISTINCT e.id,e.sha256,e.size_bytes AS sizeBytes,e.created_at
  FROM knowledge_evidence e JOIN knowledge_entity_evidence link ON link.evidence_id=e.id
  WHERE e.deleted_at IS NULL AND COALESCE(e.environment,'')=@environment
   AND (e.project_id=@projectId OR EXISTS(SELECT 1 FROM knowledge_evidence_acl a WHERE a.evidence_id=e.id AND a.project_id=@projectId))
   AND ((link.entity_type='observation' AND link.entity_id IN(SELECT id FROM scoped_observations))
    OR (link.entity_type='candidate' AND link.entity_id IN(SELECT c.id FROM knowledge_candidates c JOIN knowledge_documents d ON d.id=c.id JOIN scoped_domain_events s ON s.event_id=c.event_id WHERE d.project_id=@projectId AND COALESCE(c.environment,'')=@environment)))
 )`;
 const read=(table:'events'|'observations'|'evidence'|'retrievals',id:string)=>{
  const total=Number((store.db.prepare(`${cte} SELECT COUNT(*) AS count FROM scoped_${table}`).get(params) as {count:number}).count);
  const projection=table==='events'?'id,event_id,event_type,intent_step,objective_ref,acceptance_criterion_ref,created_at':'*';
  const order=table==='events'?'created_at,sequence':`created_at,${id}`;
  const rows=store.db.prepare(`${cte} SELECT ${projection} FROM scoped_${table} ORDER BY ${order} LIMIT @limit OFFSET @offset`).all({...params,limit,offset}) as Array<Record<string,unknown>>;
  return {rows,page:{total,returned:rows.length,limit,offset,hasMore:offset+rows.length<total}};
 };
 const events=read('events','event_id'),observations=read('observations','id'),evidence=read('evidence','id'),retrievals=read('retrievals','id');
 const eventCounts=Object.fromEntries((store.db.prepare(`${cte} SELECT event_type,COUNT(*) AS count FROM scoped_events GROUP BY event_type`).all(params) as Array<{event_type:string;count:number}>).map(row=>[row.event_type,row.count]));
 return {session,eventCounts,events:events.rows,observations:observations.rows,evidence:evidence.rows,retrievals:retrievals.rows,
  pagination:{events:events.page,observations:observations.page,evidence:evidence.page,retrievals:retrievals.page},
  coverage:{historicalUnlinkedRecords:'excluded',joinedSourceScope:'verified',standaloneEventReferences:'session_authorized',joinedContent:'references_only'} as const};
}
