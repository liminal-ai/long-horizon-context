const NODE_SQLITE_EXPERIMENTAL_WARNING = "SQLite is an experimental feature and might change at any time";

type EmitWarning = typeof process.emitWarning;

export function needsNodeSqliteWarningFilter(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return major === 24 && minor >= 3 && minor < 15;
}

export function installNodeSqliteWarningFilter(
  runtime: Pick<NodeJS.Process, "emitWarning"> = process,
  version = process.versions.node,
): void {
  if (!needsNodeSqliteWarningFilter(version)) return;

  const original = runtime.emitWarning;
  runtime.emitWarning = function filteredEmitWarning(
    warning: string | Error,
    ...args: Parameters<EmitWarning> extends [string | Error, ...infer Rest] ? Rest : never[]
  ): void {
    const message = typeof warning === "string" ? warning : warning.message;
    const warningType = typeof args[0] === "string" ? args[0] : undefined;
    if (message === NODE_SQLITE_EXPERIMENTAL_WARNING && warningType === "ExperimentalWarning") return;
    Reflect.apply(original, runtime, [warning, ...args]);
  } as EmitWarning;
}
