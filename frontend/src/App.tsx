import { Routes, Route, Navigate } from "react-router-dom";
import { useState, useEffect, createContext, useContext } from "react";
import { api } from "./api/client";
import LoginPage from "./pages/Login";
import ProjectsPage from "./pages/Projects";
import ServersPage from "./pages/Servers";
import UsersPage from "./pages/Users";
import TokensPage from "./pages/Tokens";
import InstancesPage from "./pages/Instances";
import KnowledgeOverview from "./pages/KnowledgeOverview";
import ToolsPage from "./pages/Tools";
import KnowledgeProduct from "./pages/KnowledgeProduct";
import KnowledgeProject from "./pages/KnowledgeProject";
import KnowledgeOperations from "./pages/KnowledgeOperations";
import KnowledgeSource from "./pages/KnowledgeSource";
import KnowledgeIntegrated from "./pages/KnowledgeIntegrated";
import KnowledgeMemory from "./pages/KnowledgeMemory";

import { AppShell } from "./components/shell/AppShell";

interface AuthCtx {
  user: { id: number; username: string; isAdmin: boolean } | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

export const AuthContext = createContext<AuthCtx>({} as AuthCtx);
export const useAuth = () => useContext(AuthContext);

export default function App() {
  const [user, setUser] = useState<{ id: number; username: string; isAdmin: boolean } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token) {
      api.me()
        .then((r) => setUser(r.user))
        .catch(() => localStorage.removeItem("token"))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (username: string, password: string) => {
    const r = await api.login(username, password);
    localStorage.setItem("token", r.token);
    setUser(r.user);
  };

  const register = async (username: string, password: string) => {
    const r = await api.register(username, password);
    localStorage.setItem("token", r.token);
    setUser(r.user);
  };

  const logout = () => {
    localStorage.removeItem("token");
    setUser(null);
  };

  if (loading) {
    return (
      <div className="app-shell flex min-h-screen items-center justify-center">
        <div className="text-muted">Loading…</div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ user, login, register, logout }}>
      <Routes>
        <Route
          path="/login"
          element={user ? <Navigate to="/projects" replace /> : <LoginPage />}
        />
        <Route
          path="/"
          element={user ? <AppShell /> : <Navigate to="/login" replace />}
        >
          <Route index element={<Navigate to="/projects" replace />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="servers" element={<ServersPage />} />
          <Route path="instances" element={<InstancesPage />} />
          <Route path="tools" element={<ToolsPage />} />
          <Route path="knowledge" element={<KnowledgeOverview />} />
          <Route path="knowledge/integrated" element={<KnowledgeIntegrated />} />
          <Route path="knowledge/memory" element={<KnowledgeMemory />} />
          <Route path="knowledge/sessions" element={<KnowledgeMemory />} />
          <Route path="knowledge/candidate-insights" element={<KnowledgeMemory />} />
          <Route path="knowledge/confirmed-memory" element={<KnowledgeMemory />} />
          <Route path="knowledge/product-docs" element={<KnowledgeProduct />} />
          <Route path="knowledge/product-docs/topics" element={<KnowledgeProduct />} />
          <Route path="knowledge/product-docs/imports" element={user?.isAdmin ? <KnowledgeProduct /> : <Navigate to="/knowledge/product-docs" replace />} />
          <Route path="knowledge/product-docs/versions" element={<KnowledgeProduct />} />
          <Route path="knowledge/product-docs/search" element={<KnowledgeProduct />} />
          <Route path="knowledge/solution" element={<KnowledgeSource />} />
          <Route path="knowledge/evidence" element={<KnowledgeProject />} />
          <Route path="knowledge/observations" element={<KnowledgeProject />} />
          <Route path="knowledge/candidates" element={<KnowledgeProject />} />
          <Route path="knowledge/cases" element={<KnowledgeProject />} />
          <Route path="knowledge/patterns" element={<KnowledgeProject />} />
          <Route path="knowledge/playbooks" element={<KnowledgeProject />} />
          <Route path="knowledge/operations/capture" element={<KnowledgeOperations />} />
          <Route path="knowledge/operations/ingest" element={<KnowledgeOperations />} />
          <Route path="knowledge/operations/index" element={<KnowledgeOperations />} />
          <Route path="tokens" element={<TokensPage />} />
          <Route path="users" element={user?.isAdmin ? <UsersPage /> : <Navigate to="/projects" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthContext.Provider>
  );
}
