import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowRight, BookOpen, CheckCircle2, ChevronDown, Compass, Server } from "lucide-react";
import { api, type RelayJob } from "../api/client";
import { StatusPill } from "../components/ui";
import { useAuth } from "../App";
import "./landing-v3.css";

const stages = [
  { label: "Intent", icon: Compass, input: "A request in your MCP client", process: "Identify the task and its target project.", output: "A task with a defined scope" },
  { label: "Context", icon: BookOpen, input: "The task and project scope", process: "Retrieve relevant files, product docs and confirmed memory the token can access.", output: "Context for the next action" },
  { label: "Runtime", icon: Server, input: "The task and its context", process: "Send the request to an allowed tool or connected agent.", output: "A result from the target environment" },
  { label: "Feedback", icon: CheckCircle2, input: "The result and supporting evidence", process: "Return evidence to the client and submit useful findings for review.", output: "A result the user can verify" },
] as const;

const faqs = [
  ["Which credentials does Relay manage?", "MCP Access Tokens connect clients such as Codex to Relay. Relay Agent Tokens connect Windows agents to Relay."],
  ["Do I need a project to use Knowledge?", "Product Knowledge and General Memory follow your account permission. Project Memory also requires access to the project."],
  ["When does a finding become searchable memory?", "An agent can submit a candidate with memory_capture. It becomes searchable after an administrator confirms it."],
  ["Do Windows agents require an inbound port?", "The Relay Agent runs as a Windows service and uses outbound requests to Relay."],
] as const;

function FlowPreview({ accountId }: { accountId?: number }) {
  const [recent, setRecent] = useState<{ accountId: number; job: RelayJob }>();

  useEffect(() => {
    if (accountId === undefined) return;
    let active = true;
    api.listJobs(1).then(({ jobs }) => {
      if (active && jobs[0]) setRecent({ accountId, job: jobs[0] });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [accountId]);
  const [stage, setStage] = useState<number>(0);
  const detail = stages[stage];

  return (
    <section className="landing-flow" id="how" aria-labelledby="flow-title">
      <h2 id="flow-title">How a request moves through Relay</h2>
      <div className="landing-flow-buttons" role="group" aria-label="Request steps">
        {stages.map(({ label, icon: Icon }, index) => (
          <button key={label} type="button" aria-pressed={index === stage} aria-controls="flow-detail" onClick={() => setStage(index)}>
            <Icon size={19} aria-hidden="true" />{label}
          </button>
        ))}
      </div>
      <dl className="landing-flow-detail" id="flow-detail" aria-live="polite">
        <div><dt>Input</dt><dd>{detail.input}</dd></div>
        <div><dt>What Relay does</dt><dd>{detail.process}</dd></div>
        <div><dt>Output</dt><dd>{detail.output}</dd></div>
      </dl>
      {recent && recent.accountId === accountId && (
        <Link className="landing-recent-job" to={"/jobs?job=" + encodeURIComponent(recent.job.id)}>
          <span>Latest job: {recent.job.kind.replaceAll("_", " ")}</span>
          <StatusPill status={recent.job.status} />
          <ArrowRight size={15} aria-hidden="true" />
        </Link>
      )}
    </section>
  );
}

export default function Landing() {
  const { user } = useAuth();
  const destination = user ? "/workspace" : "/apply";
  const action = user ? "Open workspace" : "Request access";

  return (
    <div className="relay-landing" id="top">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="landing-header">
        <div className="landing-wrap landing-header-row">
          <Link to="/" className="landing-brand" aria-label="Relay MCP home"><img src="/relay-mcp-logo.svg" alt="" /><span>Relay MCP</span></Link>
          <nav aria-label="Public navigation"><a href="#how">How it works</a><a href="#start">Get started</a></nav>
          <div className="landing-header-actions">
            {!user && <Link to="/login" className="landing-signin">Sign in</Link>}
            <Link className="landing-action landing-primary" to={destination}>{action}</Link>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <div className="landing-wrap landing-hero">
          <div className="landing-intro">
            <h1>Connect your agent.<br />Keep the context.</h1>
            <p>Give your MCP client scoped access to project files, connected agents and reviewed knowledge through one Relay endpoint.</p>
            <div className="landing-hero-actions">
              {user ? <Link className="landing-action landing-primary" to={destination}>{action}<ArrowRight size={16} aria-hidden="true" /></Link>
                : <a className="landing-action landing-primary" href="#start">Get started<ArrowRight size={16} aria-hidden="true" /></a>}
              <a className="landing-action landing-secondary" href="#how">See how it works<ArrowDown size={16} aria-hidden="true" /></a>
            </div>
          </div>
          <FlowPreview accountId={user?.id} />
        </div>
        <div className="landing-credentials">
          <div className="landing-wrap landing-credential-row">
            <div><strong>MCP Access Token</strong><span>Connect a client to Relay</span></div>
            <div><strong>Relay Agent Token</strong><span>Connect a Windows agent</span></div>
            <div><strong>Outbound connections</strong><span>Windows agents need no inbound port</span></div>
          </div>
        </div>
        <div className="landing-wrap landing-setup" id="start">
          <section>
            <h2>Get started</h2>
            <ol>
              <li><strong>Request access</strong><p>Sign in after an administrator approves your account.</p></li>
              <li><strong>Create an MCP Access Token</strong><p>Choose which projects, servers and Knowledge the client can access.</p></li>
              <li><strong>Connect your client</strong><p>Add the Relay endpoint and token to your MCP client. Copy the secret when it appears.</p></li>
            </ol>
            <Link className="landing-action landing-primary" to={destination}>{action}<ArrowRight size={16} aria-hidden="true" /></Link>
          </section>
          <section className="landing-faq">
            <h2>Questions</h2>
            {faqs.map(([question, answer]) => (
              <details key={question}><summary>{question}<ChevronDown size={17} aria-hidden="true" /></summary><p>{answer}</p></details>
            ))}
          </section>
        </div>
      </main>
      <footer className="landing-footer"><div className="landing-wrap landing-header-row">
        <Link to="/" className="landing-brand"><img src="/relay-mcp-logo.svg" alt="" /><span>Relay MCP</span></Link>
        <a href="#top">Back to top</a>
      </div></footer>
    </div>
  );
}
