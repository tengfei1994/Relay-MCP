import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { Badge, cardClass, formatDate } from "./KnowledgePrimitives";

type Narrative = {
  title: string; summary: string; assessment: string; recommendation: string;
  facts: string[]; unknowns: string[]; nextSteps: string[];
  sourceSignals: Array<{ source: string; text: string }>;
  environment?: string; occurredAt?: string;
};
const fallback: Narrative = {
  title: "这条候选缺少可读的执行说明", summary: "当前记录还不能清楚说明发生了什么，请先查看来源并补充说明。",
  assessment: "insufficient", recommendation: "信息不足，建议暂缓审批。",
  facts: [], unknowns: ["尚未取得原始事件的解释结果。"], nextSteps: ["核对原始记录并补充经过。"], sourceSignals: [],
};
const paragraph = "break-words text-sm leading-7 text-gray-300 [overflow-wrap:anywhere]";
const field = "w-full rounded-lg border border-gray-700 bg-gray-950 p-3 text-sm text-gray-200 outline-none focus:border-indigo-500";
const actionLabels: Record<string, string> = { reproduced: "确认复现", verified: "验证通过", approved: "批准", deprecated: "拒绝或停用", "edit.card": "编辑说明" };
function printable(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "未记录"; }

function EvidenceItem({ id, index }: { id: string; index: number }) {
  const [info, setInfo] = useState<any>(); const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.knowledgeEvidence(id).then((r) => { if (active) setInfo(r.evidence); }).catch(() => { if (active) setError("暂时无法读取证据信息"); });
    return () => { active = false; };
  }, [id]);
  const kind = info?.sourceKind === "log" ? "执行日志" : info?.sourceKind === "test" ? "验证结果" : info?.sourceKind === "manifest" ? "执行清单" : "原始记录";
  return <Link to={"/knowledge/evidence?document=" + encodeURIComponent(id)} className="block rounded-lg border border-gray-800 p-3 hover:border-indigo-600">
    <p className="text-sm text-indigo-200">证据 {index + 1} · {kind} → 查看内容</p>
    <p className="mt-1 text-xs text-gray-500">{error || (info ? (info.mimeType ?? "文件") + " · " + formatDate(info.createdAt) : "正在读取来源信息…")}</p>
  </Link>;
}

export function CandidateReviewDetail({ document, evidenceRefs, reviews, onBack, onReview, refresh, evidenceEditor }: {
  document: any; evidenceRefs: string[]; reviews: any[]; onBack: () => void;
  onReview: (action: string, reason: string, payload?: Record<string, unknown>) => Promise<void>;
  refresh: () => Promise<void>; evidenceEditor: ReactNode;
}) {
  const card = document.card ?? {}; const narrative: Narrative = document.narrative ?? fallback;
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const [evidencePage, setEvidencePage] = useState(0); const [edit, setEdit] = useState(false);
  const [summary, setSummary] = useState(String(card.summary ?? ""));
  const [problem, setProblem] = useState(String(card.problemStatement ?? ""));
  const [actions, setActions] = useState((Array.isArray(card.actions) ? card.actions : []).join("\n"));
  const [success, setSuccess] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const lifecycle: string = document.lifecycle ?? "draft";
  const draft = lifecycle === "draft";
  const perform = async (action: string) => {
    if (!reason.trim()) { setError("请填写本次决定或修改的理由。"); return; }
    setBusy(action); setError(""); setSuccess("");
    try {
      const patch = action === "edit_card" ? { card: { summary, problemStatement: problem, actions: actions.split(/\r?\n/).filter(Boolean) } } : undefined;
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
    <button onClick={onBack} className="text-sm text-gray-400 hover:text-white">← 返回候选列表</button>
    <section className={cardClass + " p-5 sm:p-6"}>
      <div className="flex flex-wrap items-center gap-2"><Badge tone="purple">候选知识</Badge><Badge>{draft ? "待审阅" : lifecycle === "deprecated" ? "已拒绝 / 停用" : lifecycle === "reproduced" ? "已确认复现" : lifecycle}</Badge><Badge tone={tone}>{narrative.assessment === "signal" ? "有待核对的异常" : narrative.assessment === "routine" ? "普通执行记录" : "需补充依据"}</Badge></div>
      <h2 className="mt-4 break-words text-xl font-semibold text-gray-100 sm:text-2xl">{narrative.title}</h2>
      <p className={"mt-3 max-w-4xl " + paragraph}>{narrative.summary}</p>
      <p className="mt-4 text-xs text-gray-500">{document.projectNameSnapshot || "当前项目"} · {narrative.environment || document.environment || "环境未记录"} · 发生于 {formatDate(narrative.occurredAt || document.createdAt)}</p>
    </section>

    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-5">
        <section className={cardClass}>
          <h3 className="font-medium text-gray-100">记录告诉了我们什么</h3>
          <ul className="mt-3 list-disc space-y-2 pl-5">{narrative.facts.map((item, i) => <li key={i} className={paragraph}>{item}</li>)}</ul>
          <h3 className="mt-5 border-t border-gray-800 pt-4 font-medium text-gray-100">还不能确定什么</h3>
          <ul className="mt-3 list-disc space-y-2 pl-5">{narrative.unknowns.map((item, i) => <li key={i} className={paragraph}>{item}</li>)}</ul>
        </section>
        {hasEdit && <section className={cardClass}><h3 className="font-medium text-gray-100">人工补充的说明</h3><p className={"mt-3 whitespace-pre-wrap " + paragraph}>{card.summary}</p><p className={"mt-2 whitespace-pre-wrap " + paragraph}>{card.problemStatement}</p></section>}
        <section className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium text-gray-100">查看依据</h3><span className="text-xs text-gray-500">{evidenceRefs.length} 份关联证据</span></div>
          <p className="mt-2 text-xs leading-5 text-gray-500">证据数量表示关联了多少份记录，不代表结论已经得到验证。</p>
          <div className="mt-3 space-y-2">{evidenceRefs.slice(evidencePage * 5, evidencePage * 5 + 5).map((id, i) => <EvidenceItem key={id} id={id} index={evidencePage * 5 + i} />)}</div>
          {!evidenceRefs.length && <p className={"mt-3 " + paragraph}>尚未关联证据，请先补充来源。</p>}
          {pages > 1 && <div className="mt-3 flex items-center justify-between gap-3 text-xs text-gray-400"><button disabled={!evidencePage} className="disabled:opacity-40" onClick={() => setEvidencePage((p) => p - 1)}>上一页</button><span>第 {evidencePage + 1} / {pages} 页</span><button disabled={evidencePage >= pages - 1} className="disabled:opacity-40" onClick={() => setEvidencePage((p) => p + 1)}>下一页</button></div>}
        </section>
      </div>
      <section className={cardClass + " min-w-0 border-indigo-900/60"}>
        <h3 className="font-medium text-indigo-200">我需要做什么</h3>
        <p className={"mt-3 " + paragraph}>{narrative.recommendation}</p>
        <ol className="mt-3 list-decimal space-y-2 pl-5">{narrative.nextSteps.map((step, i) => <li key={i} className={paragraph}>{step}</li>)}</ol>
        <div className="mt-5 border-t border-gray-800 pt-4">
          <p className="text-xs leading-6 text-gray-400">“确认复现并建立案例”会将候选和新案例标记为已复现，后续仍需验证根因和修复效果。“拒绝”会停用候选并保留审阅历史。</p>
          {draft && <label className="mt-4 flex items-start gap-2 text-sm leading-6 text-gray-300"><input type="checkbox" className="mt-1.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />我已核对证据，并确认问题能够复现。</label>}
          <label className="mt-4 block text-sm text-gray-300" htmlFor="candidate-review-reason">决定 / 修改理由</label>
          <textarea id="candidate-review-reason" className={field + " mt-2 min-h-24"} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="请说明已确认的事实，或暂不采纳的原因。" />
          <div className="mt-3 flex flex-wrap gap-2">
            {draft && <button disabled={!!busy || !confirmed || !evidenceRefs.length} onClick={() => perform("accept")} className="rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white disabled:opacity-40">确认复现并建立案例</button>}
            {draft && <button disabled={!!busy} onClick={() => perform("reject")} className="rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-200 disabled:opacity-40">拒绝此候选</button>}
            <button disabled={!!busy} onClick={() => setEdit(!edit)} className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300">{edit ? "取消编辑" : "补充 / 编辑说明"}</button>
            {!draft && lifecycle !== "deprecated" && <button disabled={!!busy} onClick={() => perform("deprecate")} className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300">停用候选</button>}
          </div>
          {lifecycle === "reproduced" && <Link to={"/knowledge/cases?document=" + encodeURIComponent("case-" + document.id)} className="mt-3 block text-sm text-indigo-300">查看已建立的案例 →</Link>}
          {busy && <p className="mt-3 text-sm text-gray-400">正在保存…</p>}{error && <p role="alert" className="mt-3 text-sm text-rose-300">{error}</p>}{success && <p role="status" className="mt-3 text-sm text-emerald-300">{success}</p>}
        </div>
      </section>
    </div>
    {edit && <section className={cardClass}><h3 className="font-medium text-gray-100">补充经过与处理建议</h3><label className="mt-3 block text-sm text-gray-400">简要说明<textarea className={field + " mt-1 min-h-20"} value={summary} onChange={(e) => setSummary(e.target.value)} /></label><label className="mt-3 block text-sm text-gray-400">问题描述<textarea className={field + " mt-1 min-h-24"} value={problem} onChange={(e) => setProblem(e.target.value)} /></label><label className="mt-3 block text-sm text-gray-400">建议操作（每行一项）<textarea className={field + " mt-1 min-h-20"} value={actions} onChange={(e) => setActions(e.target.value)} /></label><button disabled={!!busy} className="mt-3 rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white" onClick={() => perform("edit_card")}>保存说明</button></section>}

    <details className={cardClass}><summary className="cursor-pointer text-sm font-medium text-gray-300">技术详情与原始字段</summary>
      <p className="mt-3 text-xs text-gray-500">上方中文说明依据原始事件生成；此处保留具体提示、原始卡片及来源，便于核对。</p>
      {narrative.sourceSignals.map((signal, i) => <div key={i} className="mt-3"><p className="text-xs text-gray-500">{signal.source}</p><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-950 p-3 text-xs text-gray-400">{signal.text}</pre></div>)}
      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">{Object.entries({ "事件": document.eventId, "任务": document.jobId, "部署": document.deploymentId, "来源": document.sourceLocator, "文件校验值": document.sourceSha256, "可信度": card.confidence }).map(([key, value]) => <div key={key} className="min-w-0"><dt className="text-gray-500">{key}</dt><dd className="mt-1 break-all text-gray-400">{String(value ?? "未记录")}</dd></div>)}</dl>
      <details className="mt-4"><summary className="cursor-pointer text-sm text-gray-400">原始候选卡片（含假设、验证计划和来源事实）</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-500">{printable(card)}</pre></details>
      <details className="mt-3"><summary className="cursor-pointer text-sm text-gray-400">原始执行事件</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-500">{printable(document.body)}</pre></details>
      <div className="mt-4">{evidenceEditor}</div>
    </details>
    <details className={cardClass}><summary className="cursor-pointer text-sm font-medium text-gray-300">审阅历史（{reviews.length}）</summary><div className="mt-3 space-y-2">{reviews.length ? reviews.map((r) => <details key={r.id} className="rounded-lg border border-gray-800 p-3"><summary className="cursor-pointer text-sm text-gray-300">{actionLabels[r.action] ?? r.action} · {formatDate(r.created_at)}<span className="ml-2 text-gray-500">{r.reason}</span></summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-500">{printable({ before: r.before_json, after: r.after_json })}</pre></details>) : <p className="text-sm text-gray-500">尚无人工审阅记录。</p>}</div></details>
  </div>;
}
