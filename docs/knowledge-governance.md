# Knowledge governance and release boundary

This repository treats Work Sessions, Evidence and Observations as the traceable capture boundary. Candidate Insights are reviewable hypotheses; Confirmed Memory is the durable memory boundary. SQLite FTS/vector indexes and relation projections are derived data and may be rebuilt. A review action never rewrites the original Evidence.

## Lifecycle and promotion gates

| Object | Draft entry | Required promotion evidence | Default retrieval |
|---|---|---|---|
| Legacy Candidate document | capture worker or import | source event, bounded Evidence refs, project ACL | explicit legacy filter only |
| Candidate Insight | Work Session + Evidence + Observation | `fact`, `decision`, `case`, or `pattern`; always a draft until explicitly reviewed | never in default Context Pack |
| Confirmed Memory / Fact | reviewed Candidate Insight or manual review | subject/value, Evidence, scope, source, confirmer, confirmation time and audit | yes, unless deprecated |
| Confirmed Memory / Decision | reviewed Candidate Insight or manual review | decision, rationale, alternatives plus the common provenance fields | yes, unless deprecated |
| Confirmed Memory / Case | reviewed Candidate Insight or manual review | symptoms, root cause, resolution and verification plus the common provenance fields | yes, unless deprecated |
| Confirmed Memory / Pattern | reviewed Candidate Insight or manual review | applicability, signals and exceptions plus the common provenance fields | yes, unless deprecated |
| Approved Operation / Playbook | separate reviewer proposal | approved steps, rollback, target/version scope and regression evidence | only when explicitly approved |
| Skill diff | Playbook proposal output | Git diff review and release approval | never applied automatically |

Allowed lifecycle transitions are enforced in `src/knowledge/domain.ts`. Candidate Insight kind validation is strict and does not allow `observation` or `playbook`. Reviewers must provide a non-empty reason; every action stores reviewer, timestamp, before/after JSON and audit metadata. A Confirmed Memory must reference visible Evidence, scope, source, confirmer, confirmation time and an audit reason.

Candidate confirmation and memory promotion are separate actions. Confirming a Candidate Insight records reviewer acceptance; promoting creates a typed `knowledge_confirmed_memories` row. A promoted Fact cannot be read or edited as a Decision, Case or Pattern through implicit conversion. Default search and Context Pack read only confirmed memory and never include Candidate Insights or Playbooks unless an explicit filter requests those sections.

## Publication boundary

The model may suggest a Playbook or Skill diff, but it cannot approve a Playbook, write an installed Skill, deploy SampleManager changes, clear FormsBin, restart services, or execute SQL mutation. Those actions remain in the existing deployment SOP and require the normal operator approval, backup, verification and rollback controls.

`docs/superpowers/` contains planning/design material only. It is not a runtime Skill registry.

## Deprecated and replacement records

Deprecation is append-only metadata. A replacement should be linked through a `supersedes` relation and retain the original Evidence. Default retrieval excludes deprecated objects; callers must opt in to inspect historical records.

## Feedback and quality loop

Feedback is attached to the Knowledge document and audited. Golden queries live in `tests/fixtures/knowledge-golden-set.v1.json`; changes require a new version and a release note. The FTS benchmark is run with `npm run benchmark:knowledge-fts`, and the report records hardware, dataset size, cache state, query classes and P95.

## Templates

- [Case template](templates/knowledge-case.md) (legacy import/read compatibility)
- [Pattern template](templates/knowledge-pattern.md) (legacy import/read compatibility)
- [Playbook template](templates/knowledge-playbook.md) (Approved Operations only)
