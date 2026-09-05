# Knowledge governance and release boundary

This repository treats the Casebook and Evidence ledger as factual sources. SQLite FTS/vector indexes and relation projections are derived data and may be rebuilt. A review action never rewrites the original Evidence.

## Lifecycle and promotion gates

| Object | Draft entry | Required promotion evidence | Default retrieval |
|---|---|---|---|
| Candidate | capture worker or import | source event, bounded Evidence refs, project ACL | yes, unless deprecated |
| Case | reviewed candidate or Casebook import | reproducible symptom/fix and verification evidence | yes, unless deprecated |
| Pattern | verified Case promotion | one or more verified Case refs, reviewer reason, inherited Evidence refs | yes, unless deprecated |
| Playbook | reviewer proposal | approved steps, rollback, target/version scope and regression evidence | only when explicitly approved |
| Skill diff | Playbook proposal output | Git diff review and release approval | never applied automatically |

Allowed lifecycle transitions are enforced in `src/knowledge/domain.ts`. Reviewers must provide a non-empty reason; every action stores reviewer, timestamp, before/after JSON and audit metadata.

## Publication boundary

The model may suggest a Playbook or Skill diff, but it cannot approve a Playbook, write an installed Skill, deploy SampleManager changes, clear FormsBin, restart services, or execute SQL mutation. Those actions remain in the existing deployment SOP and require the normal operator approval, backup, verification and rollback controls.

`docs/superpowers/` contains planning/design material only. It is not a runtime Skill registry.

## Deprecated and replacement records

Deprecation is append-only metadata. A replacement should be linked through a `supersedes` relation and retain the original Evidence. Default retrieval excludes deprecated objects; callers must opt in to inspect historical records.

## Feedback and quality loop

Feedback is attached to the Knowledge document and audited. Golden queries live in `tests/fixtures/knowledge-golden-set.v1.json`; changes require a new version and a release note. The FTS benchmark is run with `npm run benchmark:knowledge-fts`, and the report records hardware, dataset size, cache state, query classes and P95.

## Templates

- [Case template](templates/knowledge-case.md)
- [Pattern template](templates/knowledge-pattern.md)
- [Playbook template](templates/knowledge-playbook.md)
