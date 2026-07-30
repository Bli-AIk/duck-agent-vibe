import type { DiagnosticSpec, DuckConfig, PolicyDecision, SupervisionMode } from "./types.js";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SHELL_META = /[;&|<>$`\n]/;
const READ_ONLY_COMMANDS = /^(?:pwd|ls(?:\s|$)|find(?:\s|$)|rg(?:\s|$)|grep(?:\s|$)|cat(?:\s|$)|head(?:\s|$)|tail(?:\s|$)|wc(?:\s|$)|file(?:\s|$)|git\s+(?:status|diff|log|show|branch|rev-parse|check-ignore)(?:\s|$))/;

function commandFromInput(input: Record<string, unknown>): string {
  return typeof input.command === "string" ? input.command.trim() : "";
}

function diagnosticCommandMatches(command: string, spec: DiagnosticSpec): boolean {
  const expected = [spec.command, ...spec.args].join(" ").trim();
  return command === expected;
}

function isReadOnlyCommand(command: string): boolean {
  return command.length > 0 && !SHELL_META.test(command) && READ_ONLY_COMMANDS.test(command);
}

export function evaluateToolCall(
  toolName: string,
  input: Record<string, unknown>,
  _mode: SupervisionMode,
  config: DuckConfig,
): PolicyDecision {
  if (toolName === "write" || toolName === "edit") {
    return { action: "confirm", reason: `${toolName} changes project files`, toolName };
  }
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { action: "allow", reason: "read-only tool", toolName };
  }
  if (toolName === "bash") {
    const command = commandFromInput(input);
    if (config.diagnostics.some((spec) => diagnosticCommandMatches(command, spec))) {
      return { action: "allow", reason: "explicitly configured diagnostic command", toolName };
    }
    if (isReadOnlyCommand(command)) {
      return { action: "allow", reason: "known read-only shell command", toolName };
    }
    return { action: "confirm", reason: "Bash may change project files or run an unapproved command", toolName };
  }
  return { action: "confirm", reason: "unrecognised tool is blocked by the mutation guard", toolName };
}

export function isDiagnosticCommand(command: string, config: DuckConfig): DiagnosticSpec | undefined {
  return config.diagnostics.find((spec) => diagnosticCommandMatches(command.trim(), spec));
}
