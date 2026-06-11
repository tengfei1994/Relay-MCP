import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { FolderOpen, Server, LogOut, Users } from "lucide-react";
import { useAuth } from "../App";

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const navCls = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
      isActive
        ? "bg-indigo-600 text-white"
        : "text-gray-400 hover:bg-gray-800 hover:text-gray-100"
    }`;

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      <aside className="w-56 flex flex-col bg-gray-900 border-r border-gray-800">
        <div className="p-4 border-b border-gray-800">
          <h1 className="text-sm font-semibold text-indigo-400 tracking-wide uppercase">
            Remote Ops
          </h1>
          <p className="mt-1 text-xs text-gray-500">{user?.username}{user?.isAdmin && <span className="ml-1 text-indigo-500">· admin</span>}</p>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          <NavLink to="/projects" className={navCls}>
            <FolderOpen size={15} />
            Projects
          </NavLink>
          <NavLink to="/servers" className={navCls}>
            <Server size={15} />
            Servers
          </NavLink>
          {user?.isAdmin && (
            <NavLink to="/users" className={navCls}>
              <Users size={15} />
              Users
            </NavLink>
          )}
        </nav>

        <div className="p-3 border-t border-gray-800">
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm text-gray-400 hover:bg-gray-800 hover:text-gray-100 transition-colors"
          >
            <LogOut size={15} />
            Logout
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
