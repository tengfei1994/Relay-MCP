/** Parse a numeric environment setting while keeping the effective value bounded. */
export function parseBoundedNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(fallback) || !Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    throw new Error("Invalid numeric bounds");
  }
  const trimmed = raw?.trim();
  const parsed = trimmed ? Number(trimmed) : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.trunc(parsed)))
    : fallback;
}

