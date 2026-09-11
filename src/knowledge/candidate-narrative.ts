import { runtimeProblemSignals, runtimeStreams } from "./runtime-signals.js";

export interface CandidateNarrative {
  version: string;
  assessment: "signal" | "routine" | "insufficient";
  title: string;
  summary: string;
  occurredAt?: string;
  environment?: string;
  facts: string[];
  unknowns: string[];
  recommendation: string;
  nextSteps: string[];
  sourceSignals: Array<{ source: string; text: string }>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function short(value: unknown): string { return typeof value === "string" ? value.replace(/\s+/g, " ").slice(0, 100).trim() : ""; }

/** Read-only projection over the original event; never overwrites a reviewer edit. */
export function describeCandidate(body: string, fallback: { environment?: unknown; occurredAt?: unknown } = {}): CandidateNarrative {
  let envelope: Record<string, unknown> = {};
  try { envelope = record(JSON.parse(body)); } catch { /* Plain-text legacy sources remain explicitly unknown. */ }
  const payload = record(envelope.payload);
  const input = record(payload.input);
  const environment = short(payload.environment ?? input.environment ?? fallback.environment);
  const occurredAt = short(envelope.occurredAt ?? fallback.occurredAt);
  const streams = runtimeStreams(payload);
  const signals = runtimeProblemSignals(payload);
  const output = streams.map((s) => s.text).join("\n");
  const dirs = new Map<string, boolean>();
  for (const match of output.matchAll(/(?:^|\n)\s*DIR\s+([^\r\n]+?)\s+exists=(True|False)\s*(?=\r?\n|$)/gi)) dirs.set(match[1], match[2].toLowerCase() === "true");
  const missing = [...dirs].filter(([, exists]) => !exists);
  const found = [...dirs].filter(([, exists]) => exists);
  const names = (entries: Array<[string, boolean]>) => entries.slice(0, 4).map(([path]) => {
    const marker = path.match(/\\Server\\([^\\]+)\\(.+)$/i);
    return marker ? marker[1] + " 下的 " + marker[2].replaceAll("\\", " / ") : path.split(/[\\/]/).filter(Boolean).slice(-2).join(" / ");
  }).join("、");
  const status = short(payload.status).toLowerCase();
  const success = ["succeeded", "success", "completed", "ok", "passed"].includes(status);
  const eventType = short(envelope.eventType);
  const failure = /(?:failed|interrupted|cancelled|rolled_back)$/.test(eventType) || ["failed", "failure", "error", "cancelled"].includes(status) || (typeof payload.exitCode === "number" && payload.exitCode !== 0);
  const contract = /failed|invalid/.test(short(payload.parseStatus ?? payload.parse_status)) || !!payload.parseError || !!payload.parse_error;
  const validation = short(payload.validationStatus ?? payload.validation_status);
  const incompleteValidation = ["unknown", "not_run"].includes(validation);
  const hasSignal = signals.length > 0 || failure || contract || validation === "failed";
  const truncated = /truncat(?:ed|ion)|已截断/i.test(output) || payload.truncated === true;
  const prefix = environment ? "在 " + environment + " 环境中，" : "";
  const activity = dirs.size ? "任务检查了服务器目录是否存在，并列出了其中的文件" : eventType.startsWith("deployment.") ? "系统执行了一次部署任务" : /build/.test(short(payload.kind)) ? "系统执行了一次构建任务" : "系统执行了一次远程任务";
  const facts: string[] = [];
  if (success) facts.push("执行器将本次任务报告为成功完成。任务成功不代表所有业务检查均已通过。");
  else if (failure) facts.push("任务记录显示执行未正常完成。");
  else facts.push("源记录没有给出明确的成功完成状态。");
  if (found.length) facts.push("已找到 " + names(found) + (found.length > 4 ? " 等目录。" : "。"));
  if (missing.length) facts.push("检查时未找到 " + names(missing) + "；源记录未说明这些路径是否为必需路径。");
  let title = dirs.size ? "服务器目录检查已完成" : "远程任务记录待确认";
  let finding = "";
  let nextSteps = ["确认这次任务原本要验证什么，以及实际结果是否满足要求。"];
  const first = signals[0]?.text ?? "";
  if (contract) {
    title = "任务返回结果无法按约定格式读取";
    finding = "执行结果的格式检查没有通过，下游步骤可能无法直接使用这份结果。";
    nextSteps = ["核对期望的数据格式和实际返回内容，修正后重新执行格式检查。"];
  } else if (/rolled_back/.test(eventType)) {
    title = "部署已执行回退，需要核对恢复结果";
    finding = "记录显示部署执行了回退，但仅凭该事件无法确认服务已恢复。";
    nextSteps = ["核对回退后的版本、服务状态和业务验证结果。"];
  } else if (/interrupted|cancelled/.test(eventType)) {
    title = "任务中断或被取消，完成情况待确认";
    finding = "任务没有正常结束，已经执行的步骤及其影响需要核实。";
    nextSteps = ["核对最后完成的步骤和服务器实际状态，再决定是否继续执行。"];
  } else if (/service/i.test(first) && /wait|start|ready/i.test(first)) {
    const service = first.match(/\bservice\s+['"]?([A-Za-z0-9_.-]+)/i)?.[1];
    const duration = first.match(/(\d+)\s*(?:seconds?|secs?|秒)/i)?.[1];
    title = "服务启动仍有等待提示";
    finding = "日志报告" + (service ? "服务 " + service : "服务") + "仍在等待启动" + (duration ? "，记录中的等待时间为 " + duration + " 秒" : "") + "。后续是否启动成功还需要核对。";
    nextSteps = ["查看该服务在任务结束后的实际状态，并核对启动日志中是否有最终成功或失败记录。"];
  } else if (/timeout|timed? out|超时/i.test(first)) {
    title = "操作等待超时，最终结果待确认";
    finding = "日志报告操作未在等待期限内返回。远端是否继续执行、是否最终完成，目前还不能确定。";
    nextSteps = ["先核对远端实际执行状态和最终结果，再判断是否需要重试。"];
  } else if (/denied|permission|unauthorized|权限/i.test(first)) {
    title = "操作受到访问权限限制";
    finding = "执行过程中出现访问被拒绝的提示，相关步骤可能未完成。";
    nextSteps = ["确认执行账号、访问目标及需要的权限，再重试受影响步骤。"];
  } else if (/stale|cache/i.test(first)) {
    title = "运行记录提示缓存可能过期";
    finding = "日志报告缓存状态异常，是否影响当前功能及其具体原因仍需验证。";
    nextSteps = ["核对缓存对应的版本与源文件，并验证问题是否能够复现。"];
  } else if (/missing|not found|找不到|缺失/i.test(first)) {
    title = "执行过程中有资源未找到";
    finding = "日志报告所查找的文件、依赖或其他资源不存在。需要确认查找位置是否正确，以及该资源是否必需。";
    nextSteps = ["核对原始提示中的资源名称、查找位置和配置要求。"];
  } else if (/partial|degraded|乱码/i.test(first)) {
    title = "任务输出可能不完整或不可直接使用";
    finding = "日志报告部分结果或输出质量异常，需要核对是否缺少预期数据。";
    nextSteps = ["对照预期结果检查输出的完整性和可读性。"];
  } else if (hasSignal) {
    title = failure ? "远程任务执行失败，需要补充原因" : "任务留下了需要核对的异常提示";
    finding = "源记录包含异常信号，但现有信息还不足以准确解释具体原因和业务影响。";
    nextSteps = ["打开下方定位到的源记录，补充问题描述、影响和复现结果。"];
  } else if (dirs.size) {
    title = missing.length ? "目录检查完成，部分路径未找到" : "目录检查完成，已找到所查路径";
    finding = missing.length
      ? "部分被检查路径不存在。是否属于配置问题，取决于这些路径是否本来就需要存在。"
      : "当前保留的目录结果显示所查路径存在，尚未发现明确的故障信号。";
    nextSteps = missing.length ? ["核对未找到的路径是否为实际配置所需；如果只是探索其他可能位置，可将本条视为普通检查记录。"] : ["如本次仅需确认目录和文件位置，可保留为检查证据；如需证明功能正常，还应补充功能验证。"];
  } else if (success) {
    title = "任务完成，尚未形成可复用的问题结论";
    finding = "当前保留的输出中未识别出明确异常，尚没有可供审批的根因或解决方法。";
  }
  if (finding) facts.push(finding);
  const assessment = hasSignal ? "signal" : (success && !missing.length && !truncated && !incompleteValidation && !!Object.keys(payload).length) ? "routine" : "insufficient";
  const unknowns = ["原始记录未证明根因、修复效果以及适用范围；这些内容仍需人工确认。"];
  if (truncated) unknowns.unshift("部分输出已被截断，因此无法据此排除被省略内容中的其他情况。");
  if (incompleteValidation) unknowns.unshift("运行验证尚未执行或结果未知，不能将任务结束视为验证通过。");
  if (!Object.keys(payload).length) unknowns.unshift("这是旧格式记录，缺少结构化执行上下文，暂时无法自动还原经过。");
  return {
    version: "candidate-narrative-v1", assessment, title,
    summary: prefix + activity + "。" + finding,
    environment: environment || undefined, occurredAt: occurredAt || undefined,
    facts, unknowns, nextSteps,
    recommendation: assessment === "routine"
      ? "目前更适合作为普通执行证据。如无需要复现和处理的问题，可拒绝此候选。"
      : assessment === "signal"
      ? "先核对异常及复现情况；确认问题已复现后再建立案例。根因和修复效果可在后续验证。"
      : "建议暂缓审批，先补充预期结果及检查结论。如果只是普通检查记录，可拒绝此候选。",
    sourceSignals: signals.slice(0, 4),
  };
}
