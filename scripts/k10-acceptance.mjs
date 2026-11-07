import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "test" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(process.execPath, [resolve(root, "scripts/check-mcp-boundary.mjs")]);

const testFiles = [
  "tests/knowledge-access-v2.test.ts",
  "tests/knowledge-access-http-mcp.test.ts",
  "tests/knowledge-boundary-http.test.ts",
  "tests/knowledge-deprecation-http.test.ts",
  "tests/knowledge-v2-real-e2e.test.ts",
  "tests/knowledge-v2-smoke.test.ts",
  "tests/knowledge-integrated-search.test.ts",
  "tests/knowledge-retrieval-privacy.test.ts",
  "tests/knowledge-hybrid-retriever.test.ts",
  "tests/knowledge-memory-fts.test.ts",
  "tests/knowledge-review.test.ts",
  "tests/candidate-tool-audit.test.ts",
  "tests/candidate-review.test.ts",
  "tests/candidate-coexistence-acceptance.test.ts",
  "tests/context-candidate.test.ts",
  "tests/confirmed-memory-review.test.ts",
  "tests/confirmed-memory-domain.test.ts",
  "tests/knowledge-migration.test.ts",
  "tests/knowledge-migration-rehearsal.test.ts",
  "tests/knowledge-migration-jobs.test.ts",
  "tests/knowledge-migration-jobs-http.test.ts",
  "tests/knowledge-ui-routes.test.ts",
  "tests/knowledge-ui-scope.test.ts",
  "tests/knowledge-layout-ia.test.ts",
  "tests/mcp-http.integration.test.ts",
  "tests/mcp-auth.test.ts",
  "tests/knowledge-detail-bindings.test.ts",
  "tests/knowledge-output.test.ts",
  "tests/product-knowledge-operations.test.ts",
  "tests/product-topic-review.test.ts",
  "tests/product-topic-review-http.test.ts",
  "tests/product-catalog-http.test.ts",
  "tests/wiki-citations.test.ts",
  "tests/wiki-local.test.ts",
  "tests/wiki-generation-controls-http.test.ts",
  "tests/knowledge-wiki-navigation-http.test.ts",
  "tests/knowledge-operation-audit.test.ts",
].map((file) => resolve(root, file));

const tsx = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
run(process.execPath, [tsx, "--test", "--test-concurrency=1", ...testFiles]);
