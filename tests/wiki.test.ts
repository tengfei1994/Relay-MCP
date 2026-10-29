import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore, type KnowledgeStore } from "../src/knowledge/store.ts";
import { WIKI_MIGRATION } from "../src/knowledge/migrations/037-wiki.ts";
import { WikiService } from "../src/knowledge/wiki.ts";

interface Fixture {
  store: KnowledgeStore;
  wiki: WikiService;
}

// Migration 037 is not yet registered in KnowledgeStore; tests apply it
// directly on top of the migrated store, matching the deployment-time path.
function withFixture(fn: (fixture: Fixture) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "relay-wiki-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  store.db.exec(WIKI_MIGRATION.sql);
  const clock = () => new Date("2026-10-23T00:00:00.000Z");
  return Promise.resolve((async () => {
    store.grantAcl("p1", 7, true);   // reviewer on p1
    store.grantAcl("p1", 8, false);  // read-only on p1
    store.grantAcl("p2", 10, true);  // reviewer on p2 only
    await fn({ store, wiki: new WikiService(store, clock) });
  })()).finally(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
}

function createPage(wiki: WikiService, overrides: Record<string, unknown> = {}) {
  return wiki.create({
    actorId: 7, pageKey: "pump-triage", title: "Pump triage", body: "Check the pump relay first.",
    projectId: "p1", productVersion: "12.2", topicId: "topic-pumps", solution: "SampleManager", module: "Instruments",
    sourceRefs: ["doc:manual/pump.pdf"], reason: "Initial import", ...overrides,
  });
}

test("Create is idempotent on page_key and returns a stable DTO", () => withFixture(({ store, wiki }) => {
  const page = createPage(wiki);
  assert.equal(page.status, "draft");
  assert.equal(page.currentRevision, 1);
  assert.equal(page.pageKey, "pump-triage");
  assert.deepEqual(page.sourceRefs, ["doc:manual/pump.pdf"]);
  // Stable DTO: no provider internals leak.
  const serialized = JSON.stringify(page);
  assert.ok(!/weknora|token|knowledge_base|kb_id/i.test(serialized), "DTO must not expose provider internals");

  const replay = createPage(wiki, { title: "Different title ignored", body: "Ignored body" });
  assert.equal(replay.id, page.id);
  assert.equal(replay.title, "Pump triage");
  const count = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_wiki_pages").get() as { count: number };
  assert.equal(count.count, 1);
  const revisions = wiki.listRevisions({ actorId: 7, id: page.id });
  assert.equal(revisions.length, 1);
}));

test("Create validates input and rejects secret material", () => withFixture(({ wiki }) => {
  assert.throws(() => createPage(wiki, { pageKey: " " }), /page_key/);
  assert.throws(() => createPage(wiki, { title: " " }), /title/);
  assert.throws(() => createPage(wiki, { body: "  " }), /body/);
  assert.throws(() => createPage(wiki, { reason: " " }), /reason/);
  assert.throws(() => createPage(wiki, { body: "Set apiKey: sk-live-123 in the environment" }), /sensitive/);
  assert.throws(() => createPage(wiki, { title: "token: abc123" }), /sensitive/);
}));

test("Read ACL: project pages need canRead, global pages need any readable project", () => withFixture(({ store, wiki }) => {
  const projectPage = createPage(wiki);
  const globalPage = wiki.create({ actorId: 7, pageKey: "global-faq", title: "Global FAQ", body: "Applies everywhere.", reason: "Initial" });

  assert.equal(wiki.get({ actorId: 8, id: projectPage.id }).id, projectPage.id);
  assert.throws(() => wiki.get({ actorId: 9, id: projectPage.id }), /denied/);
  assert.throws(() => wiki.getByKey({ actorId: 9, pageKey: "pump-triage" }), /denied/);

  // Actor 9 has no readable project at all: global pages are invisible.
  assert.throws(() => wiki.get({ actorId: 9, id: globalPage.id }), /denied/);
  // Actor 8 can read p1, so global pages are visible.
  assert.equal(wiki.get({ actorId: 8, id: globalPage.id }).pageKey, "global-faq");

  // Creating a project page without read access is denied.
  assert.throws(() => wiki.create({ actorId: 9, pageKey: "nope", title: "Nope", body: "Nope", projectId: "p1", reason: "x" }), /denied/);
  const nope = store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_wiki_pages WHERE page_key = 'nope'").get() as { count: number };
  assert.equal(nope.count, 0);
}));

test("List supports pagination, filters, LIKE search and hides foreign projects", () => withFixture(({ store, wiki }) => {
  createPage(wiki);
  createPage(wiki, { pageKey: "pump-install", title: "Pump installation", body: "Mounting the pump skid.", topicId: "topic-install", reason: "Initial" });
  wiki.create({ actorId: 10, pageKey: "p2-secret", title: "P2 internal", body: "Pump notes for p2.", projectId: "p2", reason: "Initial" });
  wiki.create({ actorId: 7, pageKey: "global-faq", title: "Global FAQ", body: "General guidance.", reason: "Initial" });

  const all = wiki.list({ actorId: 8, projectId: "p1" });
  assert.equal(all.total, 3); // two p1 pages + one global; p2 page hidden
  assert.ok(all.items.every((item) => item.pageKey !== "p2-secret"));
  assert.ok(!("body" in all.items[0]), "summaries omit the body");

  const page1 = wiki.list({ actorId: 8, projectId: "p1", limit: 2, offset: 0 });
  assert.equal(page1.items.length, 2);
  const page2 = wiki.list({ actorId: 8, projectId: "p1", limit: 2, offset: 2 });
  assert.equal(page2.items.length, 1);
  assert.notEqual(page1.items[0].id, page2.items[0].id);

  const searched = wiki.list({ actorId: 8, projectId: "p1", search: "skid" });
  assert.deepEqual(searched.items.map((item) => item.pageKey), ["pump-install"]);
  // LIKE wildcards in the search term are escaped, not interpreted.
  const wildcard = wiki.list({ actorId: 8, projectId: "p1", search: "100%" });
  assert.equal(wildcard.total, 0);

  const filtered = wiki.list({ actorId: 8, projectId: "p1", productVersion: "12.2", topicId: "topic-pumps", solution: "SampleManager", module: "Instruments" });
  assert.deepEqual(filtered.items.map((item) => item.pageKey), ["pump-triage"]);
  const filteredOut = wiki.list({ actorId: 8, projectId: "p1", module: "Other" });
  assert.equal(filteredOut.total, 0);

  assert.throws(() => wiki.list({ actorId: 9, projectId: "p1" }), /denied/);
  const globalOnly = wiki.list({ actorId: 8, search: "Global" });
  assert.deepEqual(globalOnly.items.map((item) => item.pageKey), ["global-faq"]);
  assert.equal(wiki.list({ actorId: 9 }).total, 0);
  store.grantAcl("p2", 9, false);
  assert.equal(wiki.list({ actorId: 9 }).total, 1); // unscoped reads remain global-only; p2 requires explicit scope
}));

test("Edit appends a revision, requires a reviewer and never stores secrets", () => withFixture(({ store, wiki }) => {
  const page = createPage(wiki);
  assert.throws(() => wiki.edit({ actorId: 8, id: page.id, body: "Read-only user edit", reason: "try" }), /reviewer/);
  const edited = wiki.edit({ actorId: 7, id: page.id, title: "Pump triage v2", body: "Check the relay, then the fuse.", reason: "Reviewer refinement" });
  assert.equal(edited.currentRevision, 2);
  assert.equal(edited.title, "Pump triage v2");
  assert.equal(edited.body, "Check the relay, then the fuse.");

  const revisions = wiki.listRevisions({ actorId: 8, id: page.id });
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].revision, 2);
  assert.equal(revisions[0].changeReason, "Reviewer refinement");
  assert.equal(revisions[0].authorId, 7);
  assert.equal(revisions[1].revision, 1);
  assert.equal(revisions[1].body, "Check the pump relay first.");
  assert.throws(() => wiki.listRevisions({ actorId: 9, id: page.id }), /denied/);

  // No-op edit is a pass-through without a new revision.
  const unchanged = wiki.edit({ actorId: 7, id: page.id, reason: "nothing changed" });
  assert.equal(unchanged.currentRevision, 2);

  assert.throws(() => wiki.edit({ actorId: 7, id: page.id, body: "password: hunter2", reason: "bad" }), /sensitive/);
  const audit = store.db.prepare("SELECT details_json FROM knowledge_audit WHERE entity_id = ? AND action = 'wiki.edit'").all(page.id) as Array<{ details_json: string }>;
  assert.equal(audit.length, 1);
  assert.ok(!audit[0].details_json.includes("Check the relay"), "audit details must not contain page bodies");
}));

test("Publish and deprecate are reviewer-only, audited and idempotent", () => withFixture(({ store, wiki }) => {
  const page = createPage(wiki);
  assert.throws(() => wiki.publish({ actorId: 8, id: page.id, reason: "ship it" }), /reviewer/);
  const published = wiki.publish({ actorId: 7, id: page.id, reason: "Reviewed against the manual" });
  assert.equal(published.status, "published");
  assert.ok(published.publishedAt);
  assert.equal(wiki.publish({ actorId: 7, id: page.id, reason: "Reviewed against the manual" }).status, "published");

  assert.throws(() => wiki.deprecate({ actorId: 8, id: page.id, reason: "old" }), /reviewer/);
  const deprecated = wiki.deprecate({ actorId: 7, id: page.id, reason: "Superseded by the 13.0 guide" });
  assert.equal(deprecated.status, "deprecated");
  assert.ok(deprecated.deprecatedAt);
  assert.equal(wiki.deprecate({ actorId: 7, id: page.id, reason: "Superseded by the 13.0 guide" }).status, "deprecated");
  assert.throws(() => wiki.edit({ actorId: 7, id: page.id, body: "too late", reason: "x" }), /deprecated/);
  assert.throws(() => wiki.publish({ actorId: 7, id: page.id, reason: "x" }), /deprecated/);
  assert.throws(() => wiki.rollback({ actorId: 7, id: page.id, revision: 1, reason: "x" }), /deprecated/);

  const actions = (store.db.prepare("SELECT action FROM knowledge_audit WHERE entity_id = ? ORDER BY occurred_at, rowid").all(page.id) as Array<{ action: string }>).map((row) => row.action);
  assert.deepEqual(actions, ["wiki.create", "wiki.publish", "wiki.deprecate"]);
}));

test("Unified diff between revisions", () => withFixture(({ wiki }) => {
  const page = createPage(wiki);
  wiki.edit({ actorId: 7, id: page.id, body: "Check the pump relay first.\nThen check the fuse.", reason: "Add fuse step" });
  const diff = wiki.diffRevisions({ actorId: 8, id: page.id, fromRevision: 1, toRevision: 2 });
  assert.match(diff, /^--- pump-triage@r1/m);
  assert.match(diff, /^\+\+\+ pump-triage@r2/m);
  assert.match(diff, /^@@/m);
  assert.match(diff, /^\+Then check the fuse\./m);
  assert.throws(() => wiki.diffRevisions({ actorId: 8, id: page.id, fromRevision: 1, toRevision: 9 }), /not found/);
  assert.throws(() => wiki.diffRevisions({ actorId: 9, id: page.id, fromRevision: 1, toRevision: 2 }), /denied/);
}));

test("Rollback appends a new revision without deleting history", () => withFixture(({ store, wiki }) => {
  const page = createPage(wiki);
  wiki.edit({ actorId: 7, id: page.id, body: "Second revision body.", reason: "Edit" });
  wiki.edit({ actorId: 7, id: page.id, body: "Third revision body.", reason: "Edit again" });
  assert.throws(() => wiki.rollback({ actorId: 8, id: page.id, revision: 1, reason: "revert" }), /reviewer/);

  const rolledBack = wiki.rollback({ actorId: 7, id: page.id, revision: 1, reason: "Restore the imported version" });
  assert.equal(rolledBack.currentRevision, 4);
  assert.equal(rolledBack.body, "Check the pump relay first.");
  assert.equal(rolledBack.status, "draft");

  const revisions = wiki.listRevisions({ actorId: 7, id: page.id });
  assert.deepEqual(revisions.map((rev) => rev.revision), [4, 3, 2, 1]);
  assert.equal(revisions[0].changeReason, "Restore the imported version");
  assert.equal(revisions[1].body, "Third revision body.");

  // Rolling back to the current revision is a no-op.
  const noop = wiki.rollback({ actorId: 7, id: page.id, revision: 4, reason: "already there" });
  assert.equal(noop.currentRevision, 4);

  const audit = store.db.prepare("SELECT details_json FROM knowledge_audit WHERE entity_id = ? AND action = 'wiki.rollback'").get(page.id) as { details_json: string };
  const details = JSON.parse(audit.details_json) as Record<string, unknown>;
  assert.equal(details.rolledBackTo, 1);
  assert.ok(!audit.details_json.includes("Check the pump relay"), "audit details must not contain page bodies");
}));
