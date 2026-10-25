import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const shellPath = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => "/" + drive.toLowerCase());
const harness = String.raw`
record() { printf '%s\n' "$*" >> "$DEPLOY_TEST_ROOT/events"; }
apt-get() { :; }; mkdir() { :; }; chmod() { :; }; ln() { :; }; rm() { :; }
nginx() { :; }; systemctl() { :; }; hostname() { printf '127.0.0.1\n'; }
openssl() { printf 'generated-test-secret-without-shell-specials\n'; }
cp() { if [ "$2" = .env ]; then command cp "$@"; fi; }
npm() {
  record "npm $*"
  if [[ "$*" = *"--prefix frontend install"* ]] || [[ "$PWD" = */frontend && "$1" = install ]]; then : > "$DEPLOY_TEST_ROOT/frontend-ready"; fi
  if [ "$*" = 'run build' ] && [ ! -f "$DEPLOY_TEST_ROOT/frontend-ready" ]; then echo 'frontend dependencies missing' >&2; return 42; fi
}
pm2() {
  record "pm2 $*"
  case "$1" in
    describe) [ "$DEPLOY_TEST_RUNNING" = 1 ] ;;
    stop) DEPLOY_TEST_RUNNING=0 ;;
    startOrRestart) DEPLOY_TEST_RUNNING=1 ;;
    startup) printf ':\n' ;;
  esac
}
node() {
  if [[ "$*" = *" -p "* || "$1" = -p ]]; then "$DEPLOY_TEST_NODE" "$@"; return; fi
  record "node $*"
  while [[ "$1" = --* ]]; do shift; done
  shift
  case "$1" in
    stop) DEPLOY_TEST_RUNNING=0 ;;
    install) if [ "$DEPLOY_TEST_RUNNING" = 1 ]; then echo 'engine must stop before install' >&2; return 43; fi ;;
    wait) if [ "$DEPLOY_TEST_FAIL_WAIT" = 1 ]; then return 44; fi ;;
  esac
}
source "$0"
`;

function deployment(options: { running?: boolean; installed?: boolean; bundle?: boolean; disabled?: boolean; failWait?: boolean; freshEnv?: boolean; frontendReady?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "relay-engine-deploy-"));
  mkdirSync(join(root, "frontend")); mkdirSync(join(root, "runtime", "knowledge-engine"), { recursive: true });
  writeFileSync(join(root, "deploy.sh"), readFileSync(resolve("deploy.sh"), "utf8").replaceAll("\r\n", "\n"));
  const config = `KNOWLEDGE_ENGINE_ENABLED=${options.disabled ? "false" : "true"}\nKNOWLEDGE_ENGINE_HOME=${shellPath(join(root, "runtime", "knowledge-engine"))}\nKNOWLEDGE_ENGINE_BUNDLE=${options.bundle ? shellPath(join(root, "verified-bundle")) : ""}\n`;
  writeFileSync(join(root, options.freshEnv ? ".env.example" : ".env"), config);
  if (options.installed) writeFileSync(join(root, "runtime", "knowledge-engine", "engine.json"), '{"sentinel":"private-state"}');
  if (options.frontendReady) writeFileSync(join(root, "frontend-ready"), "");
  const env = { ...process.env, APP_DIR: shellPath(root), DEPLOY_TEST_ROOT: shellPath(root), DEPLOY_TEST_NODE: shellPath(process.execPath), DEPLOY_TEST_RUNNING: options.running ? "1" : "0", DEPLOY_TEST_FAIL_WAIT: options.failWait ? "1" : "0" };
  for (const key of ["KNOWLEDGE_ENGINE_ENABLED", "KNOWLEDGE_ENGINE_HOME", "KNOWLEDGE_ENGINE_BUNDLE"]) delete env[key as keyof typeof env];
  const result = spawnSync(bash, ["-c", harness, shellPath(join(root, "deploy.sh"))], { encoding: "utf8", env, timeout: 20_000 });
  const events = existsSync(join(root, "events")) ? readFileSync(join(root, "events"), "utf8").trim().split("\n") : [];
  return { root, result, events, clean: () => rmSync(root, { recursive: true, force: true }) };
}
const index = (events: string[], part: string) => events.findIndex(event => event.includes(part));

test("fresh deploy installs both dependency sets before build and reads newly generated dotenv", () => {
  const f = deployment({ bundle: true, freshEnv: true });
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.ok(index(f.events, "--prefix frontend install") < index(f.events, "npm run build"));
    assert.equal(f.events.filter(event => event === "npm run build").length, 1);
    assert.ok(index(f.events, "install --bundle") >= 0);
    assert.ok(index(f.events, "knowledge-engine.mjs wait") >= 0);
    assert.ok(index(f.events, "knowledge-engine.mjs wait") < index(f.events, "--only remote-ops-web,remote-ops-mcp"));
  } finally { f.clean(); }
});

test("bundle upgrade stops supervisor and engine before install, then waits before reloading Relay", () => {
  const f = deployment({ running: true, installed: true, bundle: true, frontendReady: true });
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.ok(index(f.events, "pm2 stop remote-ops-knowledge-engine") >= 0);
    assert.ok(index(f.events, "pm2 stop remote-ops-knowledge-engine") < index(f.events, "knowledge-engine.mjs stop"));
    assert.ok(index(f.events, "knowledge-engine.mjs stop") < index(f.events, "install --bundle"));
    assert.ok(index(f.events, "install --bundle") < index(f.events, "--only remote-ops-knowledge-engine"));
    assert.ok(index(f.events, "--only remote-ops-knowledge-engine") < index(f.events, "knowledge-engine.mjs wait"));
    assert.ok(index(f.events, "knowledge-engine.mjs wait") < index(f.events, "pm2 startOrReload"));
    assert.match(readFileSync(join(f.root, "runtime", "knowledge-engine", "engine.json"), "utf8"), /private-state/);
  } finally { f.clean(); }
});

test("existing installation is reused without requiring a bundle", () => {
  const f = deployment({ installed: true, frontendReady: true });
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(index(f.events, "install --bundle"), -1);
    assert.ok(index(f.events, "--only remote-ops-knowledge-engine") >= 0);
    assert.ok(index(f.events, "pm2 startOrReload") >= 0);
  } finally { f.clean(); }
});

test("disabled engine stays stopped while Relay reloads, without installation or readiness calls", () => {
  const f = deployment({ disabled: true, installed: true, running: true, frontendReady: true });
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.ok(index(f.events, "pm2 stop remote-ops-knowledge-engine") >= 0);
    assert.equal(index(f.events, "install --bundle"), -1);
    assert.equal(index(f.events, "knowledge-engine.mjs wait"), -1);
    assert.equal(index(f.events, "--only remote-ops-knowledge-engine"), -1);
    assert.ok(index(f.events, "pm2 startOrReload") >= 0);
  } finally { f.clean(); }
});

test("failed engine readiness prevents Relay reload and PM2 save", () => {
  const f = deployment({ installed: true, frontendReady: true, failWait: true });
  try {
    assert.notEqual(f.result.status, 0);
    assert.ok(index(f.events, "knowledge-engine.mjs wait") >= 0);
    assert.equal(index(f.events, "--only remote-ops-web,remote-ops-mcp"), -1);
    assert.equal(index(f.events, "pm2 save"), -1);
  } finally { f.clean(); }
});

test("fresh installation without a bundle fails before starting or stopping services", () => {
  const f = deployment({ frontendReady: true });
  try {
    assert.notEqual(f.result.status, 0);
    assert.match(f.result.stderr, /KNOWLEDGE_ENGINE_BUNDLE/);
    assert.equal(f.events.some(event => event.startsWith("pm2 ")), false);
    assert.equal(f.events.some(event => event.includes("knowledge-engine.mjs")), false);
  } finally { f.clean(); }
});

test("unified deployment script passes Bash syntax validation", () => {
  const result = spawnSync(bash, ["-n", shellPath(resolve("deploy.sh"))], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
