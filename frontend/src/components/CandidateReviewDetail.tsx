import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { Badge, cardClass, formatDate } from "./KnowledgePrimitives";

type Narrative = {
  title: string; summary: string; assessment: string; recommendation: string;
  facts: string[]; unknowns: string[]; nextSteps: string[];
  sourceSignals: Array<{ source: string; text: string }>;
  environment?: string; occurredAt?: string;
  businessContext?: { businessPurpose: string; affectedProcess: string; businessImpact: string; technicalComponentPurpose: string; confidence: string };
};
const fallback: Narrative = {
  title: "这条候选缺少可读的执行说明", summary: "当前记录还不能清楚说明发生了什么，请先查看来源并补充说明。",
  assessment: "insufficient", recommendation: "信息不足，建议暂缓审批。",
  facts: [], unknowns: ["尚未取得原始事件的解释结果。"], nextSteps: ["核对原始记录并补充经过。"], sourceSignals: [],
};
const paragraph = "break-words text-sm leading-7 text-muted [overflow-wrap:anywhere]";
const field = "w-full rounded-field border border-line bg-[var(--field)] p-3 text-sm text-fg outline-none focus:border-mint focus:ring-2 focus:ring-mint/20";
const actionLabels: Record<string, string> = { reproduced: "确认复现", verified: "验证通过", approved: "批准", deprecated: "拒绝或停用", "edit.card": "编辑说明" };
function BusinessContext({ context }: { context?: Narrative["businessContext"] }) {
  if (!context) return <p className="text-sm text-muted">尚未记录业务场景。请在审阅时补充用途、受影响流程和业务影响。</p>;
  const rows = [["业务用途", context.businessPurpose], ["受影响流程", context.affectedProcess], ["业务影响", context.businessImpact], ["技术组件用途", context.technicalComponentPurpose]];
  return <div className="grid gap-3 sm:grid-cols-2">{rows.map(([label, value]) => <div key={label} className="glass min-w-0 rounded-field border border-line p-3"><p className="text-xs font-medium text-muted">{label}</p><p className="mt-2 break-words text-sm leading-6 text-fg">{value}</p></div>)}<p className="text-xs text-muted sm:col-span-2">以上说明为{context.confidence === "provided" ? "来源提供" : context.confidence === "inferred" ? "根据技术信号推断" : "暂缺"}，仍需结合证据确认。</p></div>;
}
type ReviewEntry = { id: string; action: string; created_at?: string; reason?: string; before_json?: unknown; after_json?: unknown };
type CandidateCard = { summary?: unknown; problemStatement?: unknown; actions?: unknown; businessContext?: Narrative["businessContext"]; confidence?: unknown };
type CandidateDocument = { id: string; card?: CandidateCard; narrative?: Narrative; lifecycle?: string; projectNameSnapshot?: string; environment?: string; createdAt?: string; eventId?: unknown; jobId?: unknown; deploymentId?: unknown; sourceLocator?: unknown; sourceSha256?: unknown; body?: unknown };
function printable(value: unknown): string {
  if (value === null || value === undefined) return "未记录";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value !== "object") return "未记录";
  try {
    return JSON.stringify(value, null, 2) ?? "未记录";
  } catch {
    return "未记录";
  }
}
type EvidenceInfo = { sourceKind?: string; mimeType?: string; createdAt?: string };
function isEvidenceInfo(value: unknown): value is EvidenceInfo { return typeof value === "object" && value !== null; }
function EvidenceItem({ id, index }: { id: string; index: number }) {
  const [info, setInfo] = useState<EvidenceInfo>(); const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.knowledgeEvidence(id).then((r) => { if (active && isEvidenceInfo(r.evidence)) setInfo(r.evidence); }).catch(() => { if (active) setError("暂时无法读取证据信息"); });
    return () => { active = false; };
  }, [id]);
  const kind = info?.sourceKind === "log" ? "执行日志" : info?.sourceKind === "test" ? "验证结果" : info?.sourceKind === "manifest" ? "执行清单" : "原始记录";
  return <Link to={"/knowledge/evidence?document=" + encodeURIComponent(id)} className="glass block rounded-field border border-line p-3 transition-colors hover:border-mint">
    <p className="text-sm text-mint">证据 {index + 1} / {kind}：查看内容</p>
    <p className="mt-1 text-xs text-muted">{error || (info ? (info.mimeType ?? "文件") + " / " + formatDate(info.createdAt) : "正在读取来源信息…")}</p>
  </Link>;
}

export function CandidateReviewDetail({ document, evidenceRefs, reviews, onBack, onReview, refresh, evidenceEditor }: {
  document: CandidateDocument; evidenceRefs: string[]; reviews: ReviewEntry[]; onBack: () => void;
  onReview: (action: string, reason: string, payload?: Record<string, unknown>) => Promise<void>;
  refresh: () => Promise<void>; evidenceEditor: ReactNode;
}) {
  const card = document.card ?? {}; const narrative: Narrative = document.narrative ?? fallback;
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const [evidencePage, setEvidencePage] = useState(0); const [edit, setEdit] = useState(false);
  const [summary, setSummary] = useState(String(card.summary ?? ""));
  const [problem, setProblem] = useState(String(card.problemStatement ?? ""));
  const [actions, setActions] = useState((Array.isArray(card.actions) ? card.actions : []).join("\n"));
  const [businessPurpose, setBusinessPurpose] = useState(String(card.businessContext?.businessPurpose ?? narrative.businessContext?.businessPurpose ?? ""));
  const [affectedProcess, setAffectedProcess] = useState(String(card.businessContext?.affectedProcess ?? narrative.businessContext?.affectedProcess ?? ""));
  const [businessImpact, setBusinessImpact] = useState(String(card.businessContext?.businessImpact ?? narrative.businessContext?.businessImpact ?? ""));
  const [technicalPurpose, setTechnicalPurpose] = useState(String(card.businessContext?.technicalComponentPurpose ?? narrative.businessContext?.technicalComponentPurpose ?? ""));
  const [success, setSuccess] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const lifecycle: string = document.lifecycle ?? "draft";
  const draft = lifecycle === "draft";
  const perform = async (action: string) => {
    if (!reason.trim()) { setError("请填写本次决定或修改的理由。"); return; }
    setBusy(action); setError(""); setSuccess("");
    try {
      const patch = action === "edit_card" ? { card: { summary, problemStatement: problem, actions: actions.split(/\r?\n/).filter(Boolean), businessContext: { businessPurpose, affectedProcess, businessImpact, technicalComponentPurpose: technicalPurpose, confidence: "provided" } } } : undefined;
      await onReview(action, reason.trim(), patch);
      await refresh(); setReason(""); setEdit(false);
      setSuccess(action === "accept" ? "已确认复现并建立案例。" : action === "edit_card" ? "说明已保存，历史版本保留在审阅记录中。" : "已记录决定。");
    } catch (err) { setError(err instanceof Error ? err.message : "保存失败，请稍后重试。"); }
    finally { setBusy(""); }
  };
  const hasEdit = reviews.some((r) => r.action === "edit.card");
  const pages = Math.max(1, Math.ceil(evidenceRefs.length / 5));
  const tone = narrative.assessment === "routine" ? "blue" : "amber";
  return <div className="space-y-5" lang="zh-CN">
    <button onClick={onBack} className="text-sm text-muted transition-colors hover:text-fg">返回候选列表</button>
    <section className={cardClass + " p-5 sm:p-6"}>
      <div className="flex flex-wrap items-center gap-2"><Badge tone="purple">候选知识</Badge><Badge>{draft ? "待审阅" : lifecycle === "deprecated" ? "已拒绝 / 停用" : lifecycle === "reproduced" ? "已确认复现" : lifecycle}</Badge><Badge tone={tone}>{narrative.assessment === "signal" ? "有待核对的异常" : narrative.assessment === "routine" ? "普通执行记录" : "需补充依据"}</Badge></div>
      <h2 className="mt-4 break-words text-xl font-semibold text-fg sm:text-2xl">{narrative.title}</h2>
      <p className={"mt-3 max-w-4xl " + paragraph}>{narrative.summary}</p>
      <p className="mt-4 text-xs text-muted">{document.projectNameSnapshot || "当前项目"} / {narrative.environment || document.environment || "环境未记录"} / 发生于 {formatDate(narrative.occurredAt || document.createdAt)}</p>
    </section>

    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-5">
        <section className={cardClass}>
          <h3 className="font-medium text-fg">这条记录对应的业务场景</h3>
          <div className="mt-3"><BusinessContext context={narrative.businessContext} /></div>
        </section>
        <section className={cardClass}>
          <h3 className="font-medium text-fg">记录告诉了我们什么</h3>
          <ul className="mt-3 list-disc space-y-2 pl-5">{narrative.facts.map((item, i) => <li key={i} className={paragraph}>{item}</li>)}</ul>
          <h3 className="mt-5 border-t border-line pt-4 font-medium text-fg">还不能确定什么</h3>
          <ul className="mt-3 list-disc space-y-2 pl-5">{narrative.unknowns.map((item, i) => <li key={i} className={paragraph}>{item}</li>)}</ul>
        </section>
        {hasEdit && <section className={cardClass}><h3 className="font-medium text-fg">人工补充的说明</h3><p className={"mt-3 whitespace-pre-wrap " + paragraph}>{printable(card.summary)}</p><p className={"mt-2 whitespace-pre-wrap " + paragraph}>{printable(card.problemStatement)}</p></section>}
        <section className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium text-fg">查看依据</h3><span className="text-xs text-muted">{evidenceRefs.length} 份关联证据</span></div>
          <p className="mt-2 text-xs leading-5 text-muted">证据数量表示关联了多少份记录，不代表结论已经得到验证。</p>
          <div className="mt-3 space-y-2">{evidenceRefs.slice(evidencePage * 5, evidencePage * 5 + 5).map((id, i) => <EvidenceItem key={id} id={id} index={evidencePage * 5 + i} />)}</div>
          {!evidenceRefs.length && <p className={"mt-3 " + paragraph}>尚未关联证据，请先补充来源。</p>}
          {pages > 1 && <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted"><button disabled={!evidencePage} className="disabled:opacity-40" onClick={() => setEvidencePage((p) => p - 1)}>上一页</button><span>第 {evidencePage + 1} / {pages} 页</span><button disabled={evidencePage >= pages - 1} className="disabled:opacity-40" onClick={() => setEvidencePage((p) => p + 1)}>下一页</button></div>}
        </section>
      </div>
      <section className={cardClass + " min-w-0 border-mint/40 bg-mint/10"}>
        <h3 className="font-medium text-mint">我需要做什么</h3>
        <p className={"mt-3 " + paragraph}>{narrative.recommendation}</p>
        <ol className="mt-3 list-decimal space-y-2 pl-5">{narrative.nextSteps.map((step, i) => <li key={i} className={paragraph}>{step}</li>)}</ol>
        <div className="mt-5 border-t border-line pt-4">
          <p className="text-xs leading-6 text-muted">“确认复现并建立案例”会将候选和新案例标记为已复现，后续仍需验证根因和修复效果。“拒绝”会停用候选并保留审阅历史。</p>
          {draft && <label className="mt-4 flex items-start gap-2 text-sm leading-6 text-fg"><input type="checkbox" className="mt-1.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />我已核对证据，并确认问题能够复现。</label>}
          <label className="mt-4 block text-sm text-fg" htmlFor="candidate-review-reason">决定 / 修改理由</label>
          <textarea id="candidate-review-reason" className={field + " mt-2 min-h-24"} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="请说明已确认的事实，或暂不采纳的原因。" />
          <div className="mt-3 flex flex-wrap gap-2">
            {draft && <button disabled={!!busy || !confirmed || !evidenceRefs.length} onClick={() => perform("accept")} className="rounded-ctl bg-mint px-3 py-2 text-sm text-ink disabled:opacity-40">确认复现并建立案例</button>}
            {draft && <button disabled={!!busy} onClick={() => perform("reject")} className="rounded-ctl border border-coral/40 bg-coral/10 px-3 py-2 text-sm text-coral disabled:opacity-40">拒绝此候选</button>}
            <button disabled={!!busy} onClick={() => setEdit(!edit)} className="rounded-ctl border border-line px-3 py-2 text-sm text-muted transition-colors hover:bg-white/[.06] hover:text-fg">{edit ? "取消编辑" : "补充 / 编辑说明"}</button>
            {!draft && lifecycle !== "deprecated" && <button disabled={!!busy} onClick={() => perform("deprecate")} className="rounded-ctl border border-line px-3 py-2 text-sm text-muted transition-colors hover:bg-white/[.06] hover:text-fg">停用候选</button>}
          </div>
          {lifecycle === "reproduced" && <Link to={"/knowledge/cases?document=" + encodeURIComponent("case-" + document.id)} className="mt-3 block text-sm text-mint">查看已建立的案例</Link>}
          {busy && <p className="mt-3 text-sm text-muted">正在保存…</p>}{error && <p role="alert" className="mt-3 text-sm text-coral">{error}</p>}{success && <p role="status" className="mt-3 text-sm text-mint">{success}</p>}
        </div>
      </section>
    </div>
    {edit && <section className={cardClass}><h3 className="font-medium text-fg">补充经过与处理建议</h3><label className="mt-3 block text-sm text-muted">简要说明<textarea className={field + " mt-1 min-h-20"} value={summary} onChange={(e) => setSummary(e.target.value)} /></label><label className="mt-3 block text-sm text-muted">问题描述<textarea className={field + " mt-1 min-h-24"} value={problem} onChange={(e) => setProblem(e.target.value)} /></label><div className="mt-4 border-t border-line pt-4"><p className="text-sm font-medium text-fg">业务场景（保存后会随 Case 保留）</p><label className="mt-3 block text-sm text-muted">业务用途<textarea className={field + " mt-1 min-h-20"} value={businessPurpose} onChange={(e) => setBusinessPurpose(e.target.value)} /></label><label className="mt-3 block text-sm text-muted">受影响流程<textarea className={field + " mt-1 min-h-20"} value={affectedProcess} onChange={(e) => setAffectedProcess(e.target.value)} /></label><label className="mt-3 block text-sm text-muted">业务影响<textarea className={field + " mt-1 min-h-20"} value={businessImpact} onChange={(e) => setBusinessImpact(e.target.value)} /></label><label className="mt-3 block text-sm text-muted">技术组件用途<textarea className={field + " mt-1 min-h-20"} value={technicalPurpose} onChange={(e) => setTechnicalPurpose(e.target.value)} /></label></div><label className="mt-3 block text-sm text-muted">建议操作（每行一项）<textarea className={field + " mt-1 min-h-20"} value={actions} onChange={(e) => setActions(e.target.value)} /></label><button disabled={!!busy} className="mt-3 rounded-ctl bg-mint px-3 py-2 text-sm text-ink disabled:opacity-40" onClick={() => perform("edit_card")}>保存说明</button></section>}

    <details className={cardClass}><summary className="cursor-pointer text-sm font-medium text-fg">技术详情与原始字段</summary>
      <p className="mt-3 text-xs text-muted">上方中文说明依据原始事件生成；此处保留具体提示、原始卡片及来源，便于核对。</p>
      {narrative.sourceSignals.map((signal, i) => <div key={i} className="mt-3"><p className="text-xs text-muted">{signal.source}</p><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-field border border-line bg-[var(--field)] p-3 text-xs text-muted">{signal.text}</pre></div>)}
      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">{Object.entries({ "事件": document.eventId, "任务": document.jobId, "部署": document.deploymentId, "来源": document.sourceLocator, "文件校验值": document.sourceSha256, "可信度": card.confidence }).map(([key, value]) => <div key={key} className="min-w-0"><dt className="text-muted">{key}</dt><dd className="mt-1 break-all text-muted">{String(value ?? "未记录")}</dd></div>)}</dl>
      <details className="mt-4"><summary className="cursor-pointer text-sm text-muted">原始候选卡片（含假设、验证计划和来源事实）</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">{printable(card)}</pre></details>
      <details className="mt-3"><summary className="cursor-pointer text-sm text-muted">原始执行事件</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">{printable(document.body)}</pre></details>
      <div className="mt-4">{evidenceEditor}</div>
    </details>
    <details className={cardClass}><summary className="cursor-pointer text-sm font-medium text-fg">审阅历史（{reviews.length}）</summary><div className="mt-3 space-y-2">{reviews.length ? reviews.map((r) => <details key={r.id} className="glass rounded-field border border-line p-3"><summary className="cursor-pointer text-sm text-fg">{actionLabels[r.action] ?? r.action} / {formatDate(r.created_at)}<span className="ml-2 text-muted">{r.reason}</span></summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">{printable({ before: r.before_json, after: r.after_json })}</pre></details>) : <p className="text-sm text-muted">尚无人工审阅记录。</p>}</div></details>
  </div>;
}
