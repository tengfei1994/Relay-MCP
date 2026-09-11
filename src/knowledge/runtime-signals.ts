import { extractExecutionSummaryStreams } from "../shared/output.js";

export type RuntimeSignal = { source: string; text: string };
const PROBLEM = /\b(?:errors?|failed|failure|warnings?|warn|degraded|partial|missing|not found|invalid|exception|timed? out|timeout|denied|unavailable|refused)\b|乱码|失败|异常|超时|权限不足/i;

export function diagnosticText(value: string): string {
  return value
    .replace(/\b(?:0|no)\s+(?:errors?|warnings?|failures?)(?:\(s\))?\b/gi, "")
    .replace(/\b(?:errors?|warnings?|failures?)\s*[:=]\s*0\b/gi, "")
    .replace(/\(\s*s\s*\)/gi, "").trim();
}

/** A filename such as timeout.dll in a directory table is not a timeout. */
export function isInventoryLine(line: string): boolean {
  return /^\s*(?:DIR\s+.+\s+exists=(?:True|False)|Directory:\s+.+|Name\s+.*(?:Length|LastWriteTime)|[-\s]+)\s*$/i.test(line)
    || /^\s*\S+\.(?:dll|exe|xml|config|pdb|bat|ps1|cs|json|log|rpf)\s+(?:[-adlrhs]+\s+)?\d+\s+\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\s+/i.test(line);
}

export function runtimeStreams(payload: Record<string, unknown>): RuntimeSignal[] {
  const legacy = extractExecutionSummaryStreams(typeof payload.summary === "string" ? payload.summary : undefined);
  const streams: RuntimeSignal[] = [];
  const add = (source: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) streams.push({ source, text: value });
  };
  add("stdout", payload.stdout ?? legacy.stdout);
  add("stderr", payload.stderr ?? legacy.stderr);
  for (const key of ["output", "result", "observedOutput", "log"]) add(key, payload[key]);
  if (Array.isArray(payload.logs)) payload.logs.forEach((item) => {
    if (typeof item === "string") add("logs", item);
    else if (item && typeof item === "object") add("logs." + String(item.level ?? "message"), item.message);
  });
  return streams;
}

/** Shared by pool promotion and the reviewer explanation, using source fields only. */
export function runtimeProblemSignals(payload: Record<string, unknown>): RuntimeSignal[] {
  const results: RuntimeSignal[] = [];
  const add = (source: string, value: unknown, explicit = false) => {
    if (Array.isArray(value)) { value.forEach((item) => add(source, item, explicit)); return; }
    if (value === true || (typeof value === "number" && value > 0)) {
      if (explicit) results.push({ source, text: String(value) });
      return;
    }
    if (typeof value !== "string") return;
    for (const raw of value.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || isInventoryLine(line) || /truncated \d+ character/i.test(line)) continue;
      const normalized = diagnosticText(line);
      if (!normalized || /^(?:\(empty\)|none|n\/a|ok|success|succeeded|passed|completed|build succeeded\.?)$/i.test(normalized)) continue;
      // A label such as "error log" says where evidence was stored, not what
      // happened.  Do not manufacture a review signal until the log contains
      // a concrete diagnostic.
      if (/^(?:error|warning|warn|diagnostic|execution)\s+logs?$/i.test(normalized)) continue;
      if (explicit || PROBLEM.test(normalized)) results.push({ source, text: line.slice(0, 1200) });
    }
  };
  for (const key of ["error", "parseError", "parse_error", "warning", "warnings", "observedSymptoms", "symptoms"]) add(key, payload[key], true);
  add("message", payload.message);
  for (const stream of runtimeStreams(payload)) add(stream.source, stream.text, stream.source === "logs.error" || stream.source === "logs.warning");
  const seen = new Set<string>();
  return results.filter((signal) => { if (seen.has(signal.text)) return false; seen.add(signal.text); return true; }).slice(0, 20);
}
