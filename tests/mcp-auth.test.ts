import assert from "node:assert/strict";
import test from "node:test";
import { extractMcpToken, queryTokenAuthEnabled } from "../src/mcp/auth.ts";

test("Authorization header always wins over the query token", () => {
  const token = extractMcpToken(
    { authorization: "Bearer header-token" },
    { token: "query-token" },
    { allowQueryToken: true }
  );
  assert.equal(token, "header-token");
});

test("query token is rejected unless the legacy switch is enabled", () => {
  assert.equal(extractMcpToken({}, { token: "query-token" }, { allowQueryToken: false }), undefined);
  assert.equal(extractMcpToken({}, { token: "query-token" }, { allowQueryToken: true }), "query-token");
});

test("malformed header and empty query values yield no token", () => {
  assert.equal(extractMcpToken({ authorization: "Basic abc" }, {}, { allowQueryToken: true }), undefined);
  assert.equal(extractMcpToken({ authorization: "Bearer " }, {}, { allowQueryToken: true }), undefined);
  assert.equal(extractMcpToken({}, { token: "" }, { allowQueryToken: true }), undefined);
  assert.equal(extractMcpToken({}, {}, { allowQueryToken: true }), undefined);
});

test("the legacy query token switch parses explicit opt-in values only", () => {
  const previous = process.env.RELAY_MCP_ALLOW_QUERY_TOKEN;
  try {
    for (const enabled of ["true", "TRUE", "1", "yes", "on"]) {
      process.env.RELAY_MCP_ALLOW_QUERY_TOKEN = enabled;
      assert.equal(queryTokenAuthEnabled(), true, `${enabled} must enable query token auth`);
    }
    for (const disabled of ["false", "0", "", "off", "banana"]) {
      process.env.RELAY_MCP_ALLOW_QUERY_TOKEN = disabled;
      assert.equal(queryTokenAuthEnabled(), false, `${disabled} must not enable query token auth`);
    }
    delete process.env.RELAY_MCP_ALLOW_QUERY_TOKEN;
    assert.equal(queryTokenAuthEnabled(), false, "absent switch defaults to disabled");
  } finally {
    if (previous === undefined) delete process.env.RELAY_MCP_ALLOW_QUERY_TOKEN;
    else process.env.RELAY_MCP_ALLOW_QUERY_TOKEN = previous;
  }
});
