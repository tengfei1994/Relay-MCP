import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { useState, useEffect, createContext, useContext } from "react";
import { api } from "./api/client";
import LoginPage from "./pages/Login";
import ProjectsPage from "./pages/Projects";
import ServersPage from "./pages/Servers";
import Layout from "./components/Layout";

interface AuthCtx {
  user: { id: number; username: string } | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

export const AuthContext = createContext<AuthCtx>({} as AuthCtx);
export const useAuth = () => useContext(AuthContext);

export default function App() {
  const [user, setUser] = useState<{ id: number; username: string } | null>(null);
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
      <div className="flex h-screen items-center justify-center bg-gray-950">
        <div className="text-gray-400">Loading…</div>
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
          element={user ? <Layout /> : <Navigate to="/login" replace />}
        >
          <Route index element={<Navigate to="/projects" replace />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="servers" element={<ServersPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthContext.Provider>
  );
}
