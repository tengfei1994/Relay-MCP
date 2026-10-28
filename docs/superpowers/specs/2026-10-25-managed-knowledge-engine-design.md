# Managed Knowledge Engine: Memory Model

## Intent

Relay's durable memory must represent what happened in a work session, what
was observed, what is only a candidate interpretation, and what a reviewer has
confirmed. The product model is therefore:

`Work Session / IntentEnvelope -> Evidence -> Observation -> Candidate Insight -> Confirmed Memory`

The arrows describe provenance, not a mandatory promotion pipeline. A
Candidate Insight never becomes default context merely because it exists or is
reviewed. A Playbook is an independently approved executable operation plan.

## Goals

- Keep `WorkSession` and `IntentEnvelope` as the scope and intent boundary.
- Restrict Candidate Insight kinds to `fact | decision | case | pattern`.
- Store Confirmed Memory as a distinct typed entity with kinds `Fact | Decision | Case | Pattern`.
- Require every Confirmed Memory to reference Evidence, scope, source, confirmer,
  confirmation time, and an audit record.
- Make default retrieval and Context Pack candidate-free and Playbook-free.
- Preserve read access to legacy Case/Pattern/Playbook rows without writing new
  lifecycle semantics to those tables.
- Keep Product Knowledge, Wiki, and WeKnora retrieval as separate planes.

## Non-goals and anti-goals

This change does not redesign Product Knowledge ingestion, Wiki revisioning, or
WeKnora provider behavior. It does not delete or rewrite legacy rows, and it
does not auto-approve or execute Playbooks. It must not present a linear
Evidence-to-Playbook lifecycle as the primary UI.

## Approaches considered

1. **Incremental compatibility (chosen).** Add a `knowledge_confirmed_memories`
   table, typed domain unions, and new retrieval/DTO paths. Legacy tables remain
   readable through an adapter and are never targets of new Candidate promotion.
   This bounds migration risk while allowing existing data to remain useful.
2. **Table replacement.** Rename and rewrite all legacy projections in place.
   This gives a smaller long-term schema but makes old database reads and rollback
   substantially riskier.
3. **Facade only.** Rename UI and DTOs while continuing to persist Case/Pattern/
   Playbook. This fails the requirement that new writes stop using the old linear
   semantics and cannot enforce Candidate exclusion from default context.

## Domain model

`CandidateInsight` is a draft analysis attached to a Work Session. Its stable
fields are `id`, `workSessionId`, `projectId`, `kind`, `statement`, `whyProposed`,
`evidenceRefs`, `intentRefs`, `reuseBoundary`, `status`, `generatedBy`, and
creation/update timestamps. `kind` is a strict discriminated union of the four
candidate kinds.

`ConfirmedMemory` is independent of Candidate Insight. Common fields are
`id`, `type`, `title`, `statement`, `details`, `projectId`, `environment`,
`scopeType`, `scopeKey`, `visibility`, `evidenceRefs`, `source`, `confirmedBy`,
`confirmedAt`, `createdAt`, `updatedAt`, and `audit`. `details` is validated by
the discriminant: Fact has a subject/value, Decision has rationale and
alternatives, Case has symptoms/root cause/resolution/verification, and Pattern
has applicability/signals/exceptions. No implicit conversion between these
types is allowed.

Playbooks are stored and reviewed as `Approved Operation` records. They are
not a Confirmed Memory type and do not appear in the default memory list.

## Persistence and migration

Migration `039-confirmed-memory` adds the new table and indexes. Evidence links
use the existing `knowledge_entity_evidence` table with entity type
`confirmed_memory`; the table also stores serialized source, scope, and audit
metadata so each record is self-contained and auditable. Existing legacy rows
remain untouched. Legacy DTOs and document routes remain readable, but never
return those rows as new Confirmed Memory writes.

## Review, promotion, and retrieval

Candidate review actions remain explicit and reasoned. Confirm marks a
Candidate Insight as reviewed; Promote requires a target among the four
Confirmed Memory types and creates exactly one typed memory, carrying verified
Evidence and scope. Reject and edit never create memory. A default search or
Context Pack queries only confirmed memories with visible Evidence and matching
project/environment/ACL. Candidate results require an explicit candidate filter;
Playbooks require an explicit approved-operation filter.

## API, MCP, and UI

HTTP and MCP expose `candidate-insight` and `confirmed-memory` DTOs with the
same discriminated types. Legacy `/knowledge/documents` and resource URIs stay
readable for old clients. The UI's primary workspace is Memory with separate
Sessions, Evidence, Observations, Candidate Insights, and Confirmed Memory
views. Confirmed Memory can filter Fact/Decision/Case/Pattern. Approved
Operations is a separate Playbook area. Details show type, status, Evidence,
scope, source, confirmer, confirmation time, and audit history. The old arrow
pipeline is removed from primary navigation.

## Verification

Regression coverage must prove strict Candidate kinds, all four Confirmed
Memory confirmations and searches, Candidate exclusion from default context,
Evidence/ACL/project/environment isolation, legacy read compatibility, new UI
navigation, and unchanged Product Knowledge/Wiki/WeKnora routes.
