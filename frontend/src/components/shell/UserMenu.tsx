import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../App";

export function UserMenu({ mobile = false }: { mobile?: boolean }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);

  const signOut = () => {
    setOpen(false);
    logout();
    navigate("/login");
  };

  if (!user) return null;
  return (
    <div ref={containerRef} className={mobile ? "shell-mobile-user" : "shell-user-wrap"}>
      <button
        type="button"
        className="shell-user-trigger"
        aria-label="Open user menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{user.username}</span>
        {user.isAdmin && <span className="shell-admin-badge">Admin</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="shell-popover" role="menu">
          <button type="button" className="shell-popover-item" role="menuitem" onClick={signOut}>
            <LogOut size={15} aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default UserMenu;
