export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export function toneOf(status: unknown): Tone {
  const text = String(status ?? 'unknown');
  if (/failed|error|deprecated|rejected/i.test(text)) return 'bad';
  if (/warning|partial|needs_review|stale|queued|running/i.test(text)) return 'warn';
  if (/approved|succeeded|verified|ready|healthy|accepted/i.test(text)) return 'ok';
  return 'neutral';
}

export function statusLabel(status: unknown): string {
  const text = String(status ?? 'unknown').replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
