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
    return { action: "confirm", reason: `${toolName} 会修改项目文件`, toolName };
  }
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { action: "allow", reason: "只读工具", toolName };
  }
  if (toolName === "bash") {
    const command = commandFromInput(input);
    if (config.diagnostics.some((spec) => diagnosticCommandMatches(command, spec))) {
      return { action: "allow", reason: "已明确配置的诊断命令", toolName };
    }
    if (isReadOnlyCommand(command)) {
      return { action: "allow", reason: "已知只读 shell 命令", toolName };
    }
    return { action: "confirm", reason: "Bash 可能修改项目文件或执行未获批准的命令", toolName };
  }
  return { action: "confirm", reason: "未识别工具被变更保护拦截", toolName };
}

export function isDiagnosticCommand(command: string, config: DuckConfig): DiagnosticSpec | undefined {
  return config.diagnostics.find((spec) => diagnosticCommandMatches(command.trim(), spec));
}
