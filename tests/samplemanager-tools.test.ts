import assert from "node:assert/strict";
import test from "node:test";
import { sqlContainsMutation } from "../src/shared/samplemanager-tools.ts";

test("sqlContainsMutation identifies statements that change data or permissions", () => {
  assert.equal(sqlContainsMutation("select * from sample"), false);
  assert.equal(sqlContainsMutation("with rows as (select 1 id) update sample set active='T'"), true);
  assert.equal(sqlContainsMutation("grant select on sample to analyst"), true);
});

test("sqlContainsMutation ignores keywords inside comments, strings, and identifiers", () => {
  assert.equal(sqlContainsMutation("select 'update sample' as note"), false);
  assert.equal(sqlContainsMutation("-- delete all rows\nselect 1"), false);
  assert.equal(sqlContainsMutation("select [update] from audit"), false);
});
