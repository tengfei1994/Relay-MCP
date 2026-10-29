import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../App";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to sign in. Please try again.";
}
export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login, register } = useAuth();
  const navigate = useNavigate();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (mode === "login") await login(username, password);
      else await register(username, password);
      navigate("/projects");
    } catch (error: unknown) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-ink text-fg flex items-center justify-center px-4 py-10">
      <section className="glass w-full max-w-md rounded-panel p-8" aria-labelledby="auth-title">
        <div className="mb-8 flex items-center gap-3">
          <img src="/relay-mcp-icon.png" alt="Relay MCP" className="h-12 w-12 rounded-panel" />
          <div><p className="font-display text-lg">Remote ops</p><p className="text-sm text-mint">Relay MCP</p></div>
        </div>
        <h1 id="auth-title" className="mb-6 font-display text-2xl">{mode === "login" ? "Sign in" : "Create an account"}</h1>
        <form onSubmit={submit} className="space-y-5">
          <div><label htmlFor="username" className="mb-1.5 block text-sm font-medium">Username</label><input id="username" type="text" value={username} onChange={(event) => setUsername(event.target.value)} required className="w-full rounded-field border border-line bg-white/5 px-3 py-2.5 text-sm text-fg focus:border-mint focus:outline-none focus:ring-2 focus:ring-mint/20" /></div>
          <div><label htmlFor="password" className="mb-1.5 block text-sm font-medium">Password</label><input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required className="w-full rounded-field border border-line bg-white/5 px-3 py-2.5 text-sm text-fg focus:border-mint focus:outline-none focus:ring-2 focus:ring-mint/20" /></div>
          {error && <p role="alert" className="rounded-field border border-coral/50 bg-coral/10 px-3 py-2 text-sm text-coral">{error}</p>}
          <button type="submit" disabled={loading} className="w-full rounded-ctl bg-mint px-4 py-2.5 text-sm font-medium text-ink transition hover:brightness-110 disabled:opacity-50">{loading ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button>
        </form>
        <p className="mt-5 text-center text-sm text-muted">{mode === "login" ? "No account?" : "Already have an account?"}{" "}<button type="button" onClick={() => setMode(mode === "login" ? "register" : "login")} className="text-mint hover:underline">{mode === "login" ? "Register" : "Sign in"}</button></p>
      </section>
    </main>
  );
}
