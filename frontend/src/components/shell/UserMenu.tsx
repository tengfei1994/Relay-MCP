import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut, UserRound, Home } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../App";

export function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstAction.current?.focus();
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
    <div ref={containerRef} className="shell-user-wrap" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }} onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    }}>
      <button
        type="button"
        ref={trigger} className="shell-user-trigger"
        aria-label="Open user menu"
        aria-expanded={open} aria-controls={open ? "shell-user-actions" : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="shell-user-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
        <span className="shell-user-name">{user.username}</span>
        {user.isAdmin && <span className="shell-admin-badge">Admin</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="shell-popover" id="shell-user-actions">
          <button type="button" className="shell-popover-item" ref={firstAction} onClick={() => { setOpen(false); trigger.current?.focus(); navigate("/account"); }}><UserRound size={15} aria-hidden="true" /> Account</button>
          <button type="button" className="shell-popover-item" onClick={() => { setOpen(false); navigate("/"); }}><Home size={15} aria-hidden="true" /> Product site</button>
          <button type="button" className="shell-popover-item" onClick={signOut}>
            <LogOut size={15} aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default UserMenu;
