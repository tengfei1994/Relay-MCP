import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowRight, BookOpen, Check, ChevronRight, FileText, Folder, FolderOpen, KeyRound, Layers, LockKeyhole, Search, ShieldCheck } from "lucide-react";
import { useAuth } from "../App";
import "./landing.css";

const tourTabs = [
  { id: "projects", title: "Projects", icon: FolderOpen, description: "The files and environments your agent can work with." },
  { id: "knowledge", title: "Knowledge", icon: BookOpen, description: "Product documents, down to the source fragment." },
  { id: "memory", title: "Memory", icon: Layers, description: "Experience that becomes reusable after human review." },
] as const;
type TourTab = typeof tourTabs[number]["id"];
const exampleDocs = [
  { title: "Connecting an MCP client", section: "Connection guide", body: "Create an MCP Access Token in your console. Choose its project scope, then use it to connect your compatible MCP client." },
  { title: "Understanding access scopes", section: "Access guide", body: "Product Knowledge and General Memory use your account permission. Project Memory follows access to its project and the scope of your MCP token." },
];

function ProductTour() {
  const [active, setActive] = useState<TourTab>("projects");
  const [file, setFile] = useState("README.md");
  const [query, setQuery] = useState("");
  const [selectedDoc, setSelectedDoc] = useState(0);
  const [scope, setScope] = useState("general");
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const changeTab = (event: KeyboardEvent, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : undefined;
    if (next === undefined) return;
    event.preventDefault(); setActive(tourTabs[next].id); buttons.current[next]?.focus();
  };
  const matches = exampleDocs.map((doc, index) => ({ ...doc, index })).filter(doc => `${doc.title} ${doc.body}`.toLowerCase().includes(query.toLowerCase()));
  const visibleDoc = matches.find(doc => doc.index === selectedDoc) ?? matches[0];
  return <div className="product-tour" data-reveal>
    <div className="tour-topbar"><span className="tour-wordmark"><span className="relay-glyph" aria-hidden="true" />Relay <span className="tour-divider">/</span> Workspace</span><span>Interactive product tour</span></div>
    <div className="tour-layout">
      <div className="tour-sidebar"><span className="tour-sidebar-label">Explore Relay</span><div className="tour-tabs" role="tablist" aria-label="Product tour">
        {tourTabs.map((tab, index) => <button key={tab.id} ref={node => { buttons.current[index] = node; }} id={`tour-tab-${tab.id}`} role="tab" aria-selected={active === tab.id} aria-controls="tour-panel" tabIndex={active === tab.id ? 0 : -1} onKeyDown={event => changeTab(event, index)} onClick={() => setActive(tab.id)}><tab.icon size={17} /><span>{tab.title}</span><ChevronRight size={14} /></button>)}
      </div><div className="tour-sidebar-note"><ShieldCheck size={17} /><p>Access follows your account and project scope.</p></div></div>
      <div className="tour-content" role="tabpanel" id="tour-panel" aria-labelledby={`tour-tab-${active}`} tabIndex={0}>
        <div className="tour-panel-heading"><div><p className="tour-label">{tourTabs.find(tab => tab.id === active)?.title}</p><h3>{active === "projects" ? "A place for the work." : active === "knowledge" ? "Answers with a source." : "Keep what you learned."}</h3></div><span className="tour-example">Illustrative content</span></div>
        <div className="tour-panel-body" key={active}>
          {active === "projects" && <div className="tour-files"><div className="tour-file-tree"><p><Folder size={15} /> Example project</p>{["README.md", "environment.md"].map(name => <button key={name} aria-pressed={file === name} onClick={() => setFile(name)}><FileText size={15} />{name}</button>)}<div className="tour-tree-caption"><LockKeyhole size={13} /> Project access required</div></div><article className="tour-document"><div className="tour-document-bar"><FileText size={14} />{file}<span>Preview</span></div><div className="tour-document-copy"><h4>{file === "README.md" ? "Everything starts with a project." : "Know the environment."}</h4><p>{file === "README.md" ? "Keep files, remote environments and project experience together. Give your client access to the resources it needs." : "Link a server to a project and select an environment. Your connection token controls which resources the client can use."}</p><div className="tour-document-rule" /><p className="tour-small-label">{file === "README.md" ? "Available in your console" : "Controlled through your token"}</p><div className="tour-resource"><FolderOpen size={16} /><span>{file === "README.md" ? "Project files" : "Project scope"}</span><Check size={14} /></div><div className="tour-resource"><KeyRound size={16} /><span>{file === "README.md" ? "Connection tokens" : "Environment selection"}</span><Check size={14} /></div></div></article></div>}
          {active === "knowledge" && <div className="tour-knowledge"><label className="tour-search"><Search size={16} /><input aria-label="Search example documents" placeholder="Search the example documents…" value={query} onChange={event => setQuery(event.target.value)} /><span>Example</span></label><div className="tour-search-results">{matches.length ? matches.map(doc => <button key={doc.index} onClick={() => setSelectedDoc(doc.index)} aria-pressed={visibleDoc?.index === doc.index}><BookOpen size={17} /><span><strong>{doc.title}</strong><small>{doc.section}</small></span><ChevronRight size={15} /></button>) : <p className="tour-empty" role="status">No example documents match. Try “access” or “client”.</p>}</div>{visibleDoc && <div className="tour-source"><span><FileText size={14} /> Example source fragment</span><p>{visibleDoc.body}</p></div>}</div>}
          {active === "memory" && <div className="tour-memory"><div className="tour-scope" role="group" aria-label="Example Memory scope">{["general", "project"].map(value => <button key={value} aria-pressed={scope === value} onClick={() => setScope(value)}>{value === "general" ? "General Memory" : "Project Memory"}</button>)}</div><article className="tour-memory-card"><div><span className="tour-confirmed"><Check size={13} /> Example confirmed Memory</span><span>{scope === "general" ? "General" : "Project"}</span></div><h4>Verify the connection after a change.</h4><p>Record the outcome and the conditions that made a fix work. Keep unknowns visible so the next task starts with context.</p><footer><ShieldCheck size={14} />{scope === "general" ? "Requires product Knowledge access" : "Requires access to the source project"}</footer></article><div className="tour-review-flow"><span>Agent submits</span><ArrowRight size={14} /><span>Admin reviews</span><ArrowRight size={14} /><span>Memory is searchable</span></div></div>}
        </div>
        <p className="tour-caption">{tourTabs.find(tab => tab.id === active)?.description}</p>
      </div>
    </div>
  </div>;
}

function BenefitReveal() {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!ref.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const words = ref.current.querySelectorAll("span");
    const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add("is-visible"); observer.unobserve(entry.target); } }), { rootMargin: "0px 0px -15% 0px", threshold: 1 });
    ref.current.classList.add("reveal-ready"); words.forEach(word => observer.observe(word));
    return () => observer.disconnect();
  }, []);
  return <p ref={ref} className="landing-statement">{"Less time rebuilding context. More room to move the work forward.".split(" ").map((word, index) => <span key={index} style={{ transitionDelay: `${index * 24}ms` }}>{word} </span>)}</p>;
}

export default function LandingPage() {
  const { user } = useAuth();
  const root = useRef<HTMLDivElement>(null);
  const destination = user ? "/projects" : "/apply";
  const action = user ? "Open console" : "Request access";
  useEffect(() => {
    if (!root.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add("is-visible"); observer.unobserve(entry.target); } }), { threshold: .08 });
    root.current.querySelectorAll("[data-reveal]").forEach(element => { element.classList.add("reveal-ready"); observer.observe(element); });
    return () => observer.disconnect();
  }, []);
  return <div className="landing" ref={root}>
    <a className="skip-link" href="#landing-main">Skip to content</a>
    <header className="landing-header"><div className="landing-header-inner"><Link className="landing-brand" to="/" aria-label="Relay home"><span className="relay-glyph" aria-hidden="true" />Relay<span className="landing-brand-small">MCP</span></Link><nav aria-label="Website navigation"><a href="#product">Product</a><a href="#knowledge">Knowledge</a><a href="#how-it-works">How it works</a><a href="#contact">Contact</a></nav><div className="landing-header-actions">{!user && <Link className="landing-signin" to="/login">Sign in</Link>}<Link className="landing-button landing-button-nav" to={destination}>{action}<ArrowRight size={15} /></Link></div></div></header>
    <main id="landing-main" tabIndex={-1}>
      <section className="landing-hero landing-container"><p className="landing-eyebrow"><span className="landing-eyebrow-line" /> A workspace for MCP clients</p><div className="landing-hero-grid"><h1>Connect your agent.<br /><span>Keep the context.</span></h1><div className="landing-hero-copy"><p>Bring project files, product knowledge and reviewed experience into Codex and other MCP clients. Manage access from one console.</p><Link className="landing-button landing-button-primary" to={destination}>{action}<ArrowRight size={17} /></Link><p className="landing-footnote"><ShieldCheck size={14} /> Access requests are reviewed by an administrator.</p></div></div><div id="product" className="landing-tour-anchor"><ProductTour /></div></section>
      <section className="landing-principles landing-container" data-reveal><p>Built around the way your work connects.</p><div><span><FolderOpen size={18} /> Project resources</span><span><BookOpen size={18} /> Product knowledge</span><span><Layers size={18} /> Reviewed experience</span></div></section>
      <section id="knowledge" className="landing-knowledge landing-container"><div className="landing-section-intro" data-reveal><p className="landing-eyebrow">Knowledge, with clear boundaries</p><h2>The right context.<br /><span>The right access.</span></h2><p>Product documentation and project experience serve different purposes. Relay keeps their permissions clear.</p></div><div className="landing-knowledge-list" data-reveal>{[
        { number: "01", title: "Product & solution knowledge", body: "Search document fragments, check the source and read the full document. Access is granted to your account, without selecting a project.", label: "User permission", icon: BookOpen },
        { number: "02", title: "Project Memory", body: "Keep confirmed decisions and experience close to the project. Access follows the project and the scope of your connection token.", label: "Project permission", icon: FolderOpen },
        { number: "03", title: "General Memory", body: "Reuse experience across projects after administrator review. Available to users with product Knowledge access.", label: "Reviewed for reuse", icon: Layers },
      ].map(item => <article key={item.number}><div className="landing-feature-heading"><span>{item.number}</span><item.icon size={20} /><h3>{item.title}</h3></div><p>{item.body}</p><small><LockKeyhole size={13} />{item.label}</small></article>)}</div></section>
      <section className="landing-reveal landing-container"><ArrowDown size={22} aria-hidden="true" /><BenefitReveal /></section>
      <section id="how-it-works" className="landing-steps landing-container"><div className="landing-section-intro" data-reveal><p className="landing-eyebrow">From your console to your client</p><h2>A few steps.<br /><span>One connection.</span></h2></div><ol data-reveal>{[
        ["01", "Request access", "Submit your account request. An administrator reviews it before you can enter the console."],
        ["02", "Choose your scope", "Create an MCP Access Token for selected projects, or for product Knowledge and General Memory only."],
        ["03", "Connect your client", "Use the token with Codex or another compatible MCP client. Manage and delete it from your console."],
      ].map(([number, title, body]) => <li key={number}><span>{number}</span><h3>{title}</h3><p>{body}</p></li>)}</ol></section>
      <section className="landing-faq landing-container" data-reveal><h2>A little more context.</h2><div>{[
        ["Which credentials does Relay manage?", "MCP Access Tokens connect clients such as Codex to Relay. Relay Agent Tokens connect configured remote agents. Neither is a model provider API key."],
        ["Do I need a project to use Knowledge?", "No. Product Knowledge and General Memory are available through a user permission. Project Memory requires access to its project."],
        ["When does an experience become Memory?", "An agent submits a selected experience as a candidate. Only administrator confirmation makes it searchable as Memory."],
        ["Can I create an account now?", "You can submit an access request. An administrator must approve it before you can sign in. Invitation codes are not required."],
      ].map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</div></section>
      <section id="contact" className="landing-contact landing-container" data-reveal><div><p className="landing-eyebrow">Your next task starts here</p><h2>Bring your work<br /><span>into context.</span></h2><Link className="landing-button landing-button-primary" to={destination}>{action}<ArrowRight size={17} /></Link></div><div className="landing-contact-note"><ShieldCheck size={22} /><h3>Need access or help?</h3><p>Contact your Relay administrator. A public contact channel is not configured for this installation.</p></div></section>
    </main>
    <footer className="landing-footer landing-container"><Link className="landing-brand" to="/"><span className="relay-glyph" aria-hidden="true" />Relay<span className="landing-brand-small">MCP</span></Link><p>Project operations. Knowledge. One connection.</p><a href="#landing-main">Back to top <ArrowRight size={14} /></a></footer>
  </div>;
}
