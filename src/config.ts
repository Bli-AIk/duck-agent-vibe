import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import type { DiagnosticSpec, DuckConfig } from "./types.js";

export const DEFAULT_CONFIG: DuckConfig = {
  enabled: true,
  guideEnabled: false,
  debounceMs: 2_000,
  maxBatchMs: 30_000,
  cooldownMs: 15 * 60_000,
  guideCooldownMs: 8_000,
  guideMinChangeScore: 2,
  largeChangeThreshold: 12,
  maxQuestionContextChars: 6_000,
  keybinding: "ctrl+shift+d",
  ignore: [],
  watch: [],
  diagnostics: [],
};

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseDiagnostic(value: unknown): DiagnosticSpec | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const command = asString(record.command, "").trim();
  if (!command) return undefined;
  return {
    name: asString(record.name, command),
    command,
    args: asStringArray(record.args),
    allowedWriteDirs: asStringArray(record.allowed_write_dirs ?? record.allowedWriteDirs),
    autoOnLargeChange: asBoolean(record.auto_on_large_change ?? record.autoOnLargeChange, false),
  };
}

export async function loadDuckConfig(root: string): Promise<{ config: DuckConfig; path?: string }> {
  const configPath = path.join(root, ".duck.toml");
  try {
    await access(configPath);
  } catch {
    return { config: { ...DEFAULT_CONFIG } };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const source = (parsed.duck && typeof parsed.duck === "object" ? parsed.duck : parsed) as Record<string, unknown>;
  const rawDiagnostics = Array.isArray(source.diagnostics) ? source.diagnostics : [];
  const diagnostics = rawDiagnostics.map(parseDiagnostic).filter((item): item is DiagnosticSpec => item !== undefined);

  return {
    path: configPath,
    config: {
      enabled: asBoolean(source.enabled, DEFAULT_CONFIG.enabled),
      guideEnabled: asBoolean(source.guide_enabled ?? source.guideEnabled, DEFAULT_CONFIG.guideEnabled),
      debounceMs: Math.max(250, asNumber(source.debounce_ms, DEFAULT_CONFIG.debounceMs)),
      maxBatchMs: Math.max(1_000, asNumber(source.max_batch_ms, DEFAULT_CONFIG.maxBatchMs)),
      cooldownMs: Math.max(0, asNumber(source.cooldown_ms, DEFAULT_CONFIG.cooldownMs)),
      guideCooldownMs: Math.max(0, asNumber(source.guide_cooldown_ms, DEFAULT_CONFIG.guideCooldownMs)),
      guideMinChangeScore: Math.max(0, asNumber(source.guide_min_change_score, DEFAULT_CONFIG.guideMinChangeScore)),
      largeChangeThreshold: Math.max(1, asNumber(source.large_change_threshold, DEFAULT_CONFIG.largeChangeThreshold)),
      maxQuestionContextChars: Math.max(1_000, asNumber(source.max_question_context_chars, DEFAULT_CONFIG.maxQuestionContextChars)),
      keybinding: asString(source.keybinding, DEFAULT_CONFIG.keybinding),
      ignore: asStringArray(source.ignore),
      watch: asStringArray(source.watch),
      diagnostics,
      supervisorProvider: typeof source.supervisor_provider === "string" ? source.supervisor_provider : undefined,
      supervisorModel: typeof source.supervisor_model === "string" ? source.supervisor_model : undefined,
    },
  };
}
