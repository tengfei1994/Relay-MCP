import assert from "node:assert/strict";
import test from "node:test";
import { mergeWikiPageSources } from "../frontend/src/knowledge/wiki-citations.ts";

test("Wiki page sources deduplicate documents across sections and merge chunk coverage", () => {
  const sources = mergeWikiPageSources([
    { title: "Common", citations: [{ documentId: "doc-21.1", title: "Adding Attachments", productVersion: "21.1", chunkIds: ["chunk-1"] }, { documentId: "doc-21.3", title: "Adding Attachments", productVersion: "21.3", chunkIds: ["chunk-a"] }] },
    { title: "Controls", citations: [{ documentId: "doc-21.1", title: "Adding Attachments", productVersion: "21.1", chunkIds: ["chunk-2", "chunk-1"] }] },
    { title: "Difference", citations: [{ documentId: "doc-21.3", title: "Adding Attachments", productVersion: "21.3", chunkIds: ["chunk-b"] }] },
  ], []);

  assert.equal(sources.length, 2);
  assert.deepEqual(sources.map((source) => source.citation.documentId), ["doc-21.1", "doc-21.3"]);
  assert.deepEqual(sources[0]?.citation.chunkIds, ["chunk-1", "chunk-2"]);
  assert.deepEqual(sources[0]?.sectionTitles, ["Common", "Controls"]);
  assert.deepEqual(sources[1]?.citation.chunkIds, ["chunk-a", "chunk-b"]);
  assert.deepEqual(sources[1]?.sectionTitles, ["Common", "Difference"]);
});

test("Wiki page sources fall back to page citations when no section citations exist", () => {
  const sources = mergeWikiPageSources([], [{ documentId: "doc-1", title: "Source", chunkIds: ["chunk-1"] }]);
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0]?.citation.chunkIds, ["chunk-1"]);
  assert.deepEqual(sources[0]?.sectionTitles, []);
});
