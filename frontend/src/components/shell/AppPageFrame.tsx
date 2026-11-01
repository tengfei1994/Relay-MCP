import type { ReactNode } from "react";

interface AppPageFrameProps {
  children: ReactNode;
  className?: string;
  variant?: "standard" | "wide";
}

export function AppPageFrame({ children, className, variant = "standard" }: AppPageFrameProps) {
  return <div className={`app-page-frame app-page-frame-${variant}${className ? ` ${className}` : ""}`}>{children}</div>;
}

