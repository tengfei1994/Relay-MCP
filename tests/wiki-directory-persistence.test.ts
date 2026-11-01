import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import {
  backfillWikiDirectoryAssignments,
  listWikiDirectoryAssignments,
  refreshWikiDirectoryAssignments,
  classifyWikiDirectory,
} from "../src/knowledge/wiki-directory-assignments.ts";

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}

test("directory classification uses topic families and has no alphabet buckets", () => {
  const result = classifyWikiDirectory([
    { identityKey: "topic:a", pageId: "a", title: "Sample one", rawPath: "SampleManager/Sample/Sample one" },
    { identityKey: "topic:b", pageId: "b", title: "Sample two", rawPath: "SampleManager/Sample/Sample two" },
    { identityKey: "topic:c", pageId: "c", title: "One off", rawPath: "SampleManager/Unique/One off" },
  ]);

  assert.deepEqual(result.get("topic:a")?.displayPath, ["SampleManager", "Topic families", "Sample"]);
  assert.deepEqual(result.get("topic:b")?.displayPath, ["SampleManager", "Topic families", "Sample"]);
  assert.deepEqual(result.get("topic:c")?.displayPath, ["SampleManager", "Other topics"]);
  assert.equal(result.get("topic:c")?.directoryContext, "Unique");
  assert.ok(![...result.values()].some((item) => item.displayPath.some((segment) => /^[A-Z]$|^0–9$|^#$/.test(segment))));
});

test("same topic group keeps its persisted assignment when a new version is added", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-wiki-directory-persist-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    const first = backfillWikiDirectoryAssignments(store, { projectId: undefined, environment: undefined });
    assert.equal(first.written, 0);
    store.db.prepare(`INSERT INTO knowledge_wiki_pages
      (id,page_key,title,body,status,project_id,environment,product_version,topic_id,topic_group_id,solution,module,source_refs_json,supported_versions_json,generation_status,generation_fingerprint,directory_path,current_revision,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "page-a", "topic/a", "Topic A", "body", "published", null, null, null, "topic-a", "topic-a", null, null, "[]", "[\"20.3\"]", "succeeded", "fp-a", "Product/Topic A/Topic A", 1, 0, "2026-11-01", "2026-11-01",
    );
    backfillWikiDirectoryAssignments(store, {});
    const before = listWikiDirectoryAssignments(store, {}).find((item) => item.pageId === "page-a");
    assert.ok(before);

    store.db.prepare(`INSERT INTO knowledge_wiki_pages
      (id,page_key,title,body,status,project_id,environment,product_version,topic_id,topic_group_id,solution,module,source_refs_json,supported_versions_json,generation_status,generation_fingerprint,directory_path,current_revision,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "page-b", "topic/b", "Topic B", "body", "published", null, null, null, "topic-a", "topic-a", null, null, "[]", "[\"22.0\"]", "succeeded", "fp-b", "Product/Topic A/Topic B", 1, 0, "2026-11-01", "2026-11-01",
    );
    refreshWikiDirectoryAssignments(store, { topicGroupIds: ["topic-a"] });
    const after = listWikiDirectoryAssignments(store, {}).find((item) => item.pageId === "page-a");
    assert.deepEqual(after?.displayPath, before?.displayPath);
  } finally {
    store.close();
    cleanup(root);
  }
});

test("refreshing one topic group leaves an unrelated assignment unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-wiki-directory-scope-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  try {
    const insert = store.db.prepare(`INSERT INTO knowledge_wiki_pages
      (id,page_key,title,body,status,project_id,environment,product_version,topic_id,topic_group_id,solution,module,source_refs_json,supported_versions_json,generation_status,generation_fingerprint,directory_path,current_revision,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run("page-a", "topic/a", "Topic A", "body", "published", null, null, null, "topic-a", "topic-a", null, null, "[]", "[]", "succeeded", "fp-a", "Product/Alpha/Topic A", 1, 0, "2026-11-01", "2026-11-01");
    insert.run("page-b", "topic/b", "Topic B", "body", "published", null, null, null, "topic-b", "topic-b", null, null, "[]", "[]", "succeeded", "fp-b", "Product/Beta/Topic B", 1, 0, "2026-11-01", "2026-11-01");
    backfillWikiDirectoryAssignments(store, {});
    const before = listWikiDirectoryAssignments(store, {}).find((item) => item.pageId === "page-b");
    refreshWikiDirectoryAssignments(store, { topicGroupIds: ["topic-a"] });
    const after = listWikiDirectoryAssignments(store, {}).find((item) => item.pageId === "page-b");
    assert.deepEqual(after, before);
  } finally {
    store.close();
    cleanup(root);
  }
});
