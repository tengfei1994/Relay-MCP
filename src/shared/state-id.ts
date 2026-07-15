export function validateStateId(id: string, label = "state id"): string {
  if (!id || id.includes("..") || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid ${label}`);
  }
  return id;
}
