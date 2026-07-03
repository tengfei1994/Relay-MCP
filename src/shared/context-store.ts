import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import "dotenv/config";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const STATE_ROOT = process.env.RELAY_STATE_ROOT ?? join(WORKSPACE_ROOT, ".relay-mcp");
const CONTEXT_ROOT = join(STATE_ROOT, "context");

export interface ProjectFact {
  at: string;
  userId: number;
  username: string;
  project: string;
  text: string;
  tags: string[];
}

function factPath(userId: number, project: string): string {
  mkdirSync(CONTEXT_ROOT, { recursive: true });
  const safeProject = project.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return join(CONTEXT_ROOT, `${userId}-${safeProject}.jsonl`);
}

export function recordFact(user: { id: number; username: string }, project: string, text: string, tags: string[] = []): ProjectFact {
  const fact: ProjectFact = {
    at: new Date().toISOString(),
    userId: user.id,
    username: user.username,
    project,
    text,
    tags,
  };
  appendFileSync(factPath(user.id, project), JSON.stringify(fact) + "\n", "utf8");
  return fact;
}

export function searchFacts(userId: number, project: string, query = "", limit = 10): ProjectFact[] {
  const path = factPath(userId, project);
  if (!existsSync(path)) return [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProjectFact)
    .filter((fact) => {
      if (terms.length === 0) return true;
      const haystack = `${fact.text} ${fact.tags.join(" ")}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}
