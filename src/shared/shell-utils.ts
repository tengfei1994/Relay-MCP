export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function validateGitRef(value: string): string {
  if (
    !value ||
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    !/^[A-Za-z0-9._/-]+$/.test(value)
  ) {
    throw new Error(`Invalid Git ref: ${value}`);
  }
  return value;
}

export function validateServiceName(value: string): string {
  if (!/^[A-Za-z0-9_.@:-]+$/.test(value)) {
    throw new Error(`Invalid service name: ${value}`);
  }
  return value;
}

export function validateSampleManagerIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9_$-]+$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

export function validateRelativeRemotePath(value: string, label: string): string {
  if (!value || /^[\\/]/.test(value) || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error(`${label} must be a relative path without '..' segments`);
  }
  return value;
}
