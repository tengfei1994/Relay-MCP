import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../App";
import { ArrowLeft, ArrowRight, BookOpen, FolderOpen, Layers } from "lucide-react";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to sign in. Please try again.";
}
export default function LoginPage({ initialMode = "login" }: { initialMode?: "login" | "register" }) {
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(() => {
    const expired = sessionStorage.getItem("relay-session-expired");
    sessionStorage.removeItem("relay-session-expired");
    return expired ? "Your session has ended. Please sign in again." : "";
  });
  const [loading, setLoading] = useState(false);
  const { login, register } = useAuth();
  const navigate = useNavigate();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setLoading(true);
    try {
      if (mode === "login") await login(username, password);
      else {
        const status = await register(username, password);
        if (status === "pending") {
          setPassword("");
          setMode("login");
          setNotice("Your request was submitted. An administrator must approve it before you can sign in.");
          return;
        }
      }
      navigate("/projects");
    } catch (error: unknown) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-page text-fg">
      <aside className="auth-intro" aria-label="About Relay">
        <Link to="/" className="auth-brand"><span className="auth-brand-mark" aria-hidden="true" />Relay<span>MCP</span></Link>
        <div className="auth-intro-copy"><p className="auth-caption">Your workspace, connected</p><h2>Keep your work<br />in context.</h2><p>Projects, product knowledge and reviewed experience. Ready for the client you already use.</p><div className="auth-pillars"><span><FolderOpen size={18} />Projects</span><span><BookOpen size={18} />Knowledge</span><span><Layers size={18} />Memory</span></div></div>
        <p className="auth-intro-footer">Access is managed by your Relay administrator.</p>
      </aside>
      <section className="auth-form-section" aria-labelledby="auth-title">
        <Link to="/" className="auth-back"><ArrowLeft size={15} />Back to Relay</Link>
        <h1 id="auth-title" className="mb-3 font-display text-2xl">{mode === "login" ? "Sign in" : "Request access"}</h1>
        <p className="mb-6 text-sm text-muted">{mode === "login" ? "Sign in to your Relay console." : "Create an access request for an administrator to review."}</p>
        <form onSubmit={submit} className="space-y-5">
          <div><label htmlFor="username" className="mb-1.5 block text-sm font-medium">Username</label><input id="username" type="text" minLength={2} maxLength={50} autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required className="w-full rounded-field border border-line bg-white/5 px-3 py-2.5 text-sm text-fg focus:border-mint focus:outline-none focus:ring-2 focus:ring-mint/20" />{mode === "register" && <p className="mt-1 text-xs text-muted">Use letters, numbers, hyphens or underscores.</p>}</div>
          <div><label htmlFor="password" className="mb-1.5 block text-sm font-medium">Password</label><input id="password" type="password" minLength={6} autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} required className="w-full rounded-field border border-line bg-white/5 px-3 py-2.5 text-sm text-fg focus:border-mint focus:outline-none focus:ring-2 focus:ring-mint/20" /></div>
          {error && <p role="alert" className="rounded-field border border-coral/50 bg-coral/10 px-3 py-2 text-sm text-coral">{error}</p>}
          {notice && <p role="status" className="rounded-field border border-mint/40 bg-mint/10 px-3 py-2 text-sm text-fg">{notice}</p>}
          <button type="submit" disabled={loading} className="auth-submit">{loading ? "Please wait…" : mode === "login" ? "Sign in" : "Submit request"}<ArrowRight size={16} /></button>
        </form>
        <p className="mt-5 text-center text-sm text-muted">{mode === "login" ? "No account?" : "Already have an account?"}{" "}<button type="button" onClick={() => { setError(""); setNotice(""); setMode(mode === "login" ? "register" : "login"); }} className="text-mint hover:underline">{mode === "login" ? "Request access" : "Sign in"}</button></p>
      </section>
    </main>
  );
}
