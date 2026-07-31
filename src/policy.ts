import type { DiagnosticSpec, DuckConfig, PolicyDecision, SupervisionMode } from "./types.js";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const DANGEROUS_COMMANDS = [
  /^(?:env\s+)?(?:rm|rmdir|mv|cp|mkdir|touch|tee|truncate|dd|shred|install|chmod|chown|chgrp|ln)\b/i,
  /^(?:env\s+)?(?:sudo|doas|su|kill|pkill|killall|reboot|shutdown)\b/i,
  /^(?:env\s+)?systemctl\s+(?:start|stop|restart|enable|disable)\b/i,
  /^(?:env\s+)?service\s+\S+\s+(?:start|stop|restart)\b/i,
  /^(?:env\s+)?git\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone|clean|rm|mv)\b/i,
  /^(?:env\s+)?(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall|update|upgrade|ci|link|publish|init|create)\b/i,
  /^(?:env\s+)?(?:pip|pip3|poetry)\s+(?:install|add|remove|update)\b/i,
  /^(?:env\s+)?cargo\s+(?:new|init|add|remove|install|update|publish|run|generate)\b/i,
  /^(?:env\s+)?(?:vim?|nvim|nano|emacs|code|subl)\b/i,
  /^(?:env\s+)?(?:python|python3|node|deno|ruby|perl|php|bash|sh|zsh)\s+(?:-c|--eval)\b/i,
  /^(?:env\s+)?find\b.*(?:^|\s)-exec(?:dir)?\b/i,
];

const READ_ONLY_COMMANDS = /^(?:pwd\b|ls\b|find\b|rg\b|grep\b|cat\b|head\b|tail\b|nl\b|less\b|more\b|wc\b|file\b|stat\b|du\b|tree\b|sort\b|uniq\b|diff\b|which\b|whereis\b|type\b|printf\b|echo\b|git\s+(?:status|diff|log|show|branch|remote|rev-parse|check-ignore|ls-files)\b)/i;
const PROJECT_CHECK_COMMANDS = /^(?:(?:cargo\s+(?:check|test|build|clippy)\b|cargo\s+fmt\b.*(?:--check\b)|go\s+(?:test|vet|build)\b|(?:npm|pnpm|yarn|bun)\s+(?:test\b|run\s+(?:check|test|lint|typecheck|build)\b)|(?:python|python3)\s+-m\s+(?:pytest|unittest)\b|pytest\b|mvn\s+(?:test|verify)\b|gradle(?:w)?\s+(?:check|test|build)\b|dotnet\s+(?:build|test)\b))/i;

function commandFromInput(input: Record<string, unknown>): string {
  return typeof input.command === "string" ? input.command.trim() : "";
}

function diagnosticCommandMatches(command: string, spec: DiagnosticSpec): boolean {
  const expected = [spec.command, ...spec.args].join(" ").trim();
  return command === expected;
}

function splitReadOnlyShell(command: string): string[] | undefined {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;

  const pushSegment = (end: number): boolean => {
    const segment = command.slice(start, end).trim();
    if (!segment) return false;
    segments.push(segment);
    return true;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === "$") return undefined;
      else if (character === "`") return undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "<" || character === ">" || character === ";" || character === "\n" || character === "\r" || character === "$") return undefined;
    if (character === "`") return undefined;
    if (character === "&") {
      if (command[index + 1] !== "&" || !pushSegment(index)) return undefined;
      index += 1;
      start = index + 1;
      continue;
    }
    if (character === "|") {
      if (!pushSegment(index)) return undefined;
      if (command[index + 1] === "|") index += 1;
      start = index + 1;
    }
  }

  if (quote || !pushSegment(command.length)) return undefined;
  return segments;
}

function isReadOnlyCommand(command: string): boolean {
  const segments = splitReadOnlyShell(command);
  if (!segments || DANGEROUS_COMMANDS.some((pattern) => segments.some((segment) => pattern.test(segment)))) return false;
  return segments.every((segment) => READ_ONLY_COMMANDS.test(segment) || PROJECT_CHECK_COMMANDS.test(segment));
}

export function isProjectCheckCommand(command: string): boolean {
  const segments = splitReadOnlyShell(command);
  return Boolean(segments?.length === 1 && PROJECT_CHECK_COMMANDS.test(segments[0] ?? ""));
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
