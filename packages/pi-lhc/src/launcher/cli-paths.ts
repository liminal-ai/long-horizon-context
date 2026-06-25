import { isAbsolute, resolve } from "node:path";

function isLocalPath(value: string): boolean {
  const trimmed = value.trim();
  if (
    trimmed.startsWith("npm:") ||
    trimmed.startsWith("git:") ||
    trimmed.startsWith("github:") ||
    trimmed.startsWith("http:") ||
    trimmed.startsWith("https:") ||
    trimmed.startsWith("ssh:")
  ) {
    return false;
  }
  return true;
}

/** Resolve relative CLI resource paths against the effective cwd. */
export function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
  return paths?.map((value) => {
    if (!isLocalPath(value)) return value;
    return isAbsolute(value) ? value : resolve(cwd, value);
  });
}
