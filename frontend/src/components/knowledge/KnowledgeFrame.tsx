import type { ReactNode } from "react";
import "./knowledge-frame.css";

interface KnowledgeFrameProps {
  children: ReactNode;
  className?: string;
}

function frameClass(base: string, className?: string) {
  return [base, className].filter(Boolean).join(" ");
}

export function StandardPage({ children, className }: KnowledgeFrameProps) {
  return <div className={frameClass("knowledge-page-frame knowledge-page-frame-standard", className)}>{children}</div>;
}

export function WorkspacePage({ children, className }: KnowledgeFrameProps) {
  return <div className={frameClass("knowledge-page-frame knowledge-page-frame-workspace", className)}>{children}</div>;
}

