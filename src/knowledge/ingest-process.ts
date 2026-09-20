import { createKnowledgeStore } from "./store.js";
import { executeIngestJob } from "./ingest-worker.js";
import { Worker } from "node:worker_threads";

// This executable is forked, never imported by the HTTP server.
const [dbPath, id] = process.argv.slice(2);
// A separate watchdog can run even when parsing occupies the main JS thread.
// Prevent an orphan importer after an abrupt parent death (including SIGKILL).
const watchdog = new Worker(`const { workerData } = require('node:worker_threads'); setInterval(() => { if (process.ppid !== workerData) process.kill(process.pid, 'SIGKILL'); }, 1000);`, { eval: true, workerData: process.ppid });
watchdog.unref();
const store = createKnowledgeStore({ dbPath });
try {
  await executeIngestJob(store, id);
} finally {
  store.close();
  process.disconnect?.();
}
