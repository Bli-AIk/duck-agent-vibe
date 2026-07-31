export type SupervisionMode = "on" | "off";
export type ChangeSource = "git" | "snapshot";

export interface DiagnosticSpec {
  name: string;
  command: string;
  args: string[];
  allowedWriteDirs: string[];
  autoOnLargeChange: boolean;
}

export interface DuckConfig {
  enabled: boolean;
  guideEnabled: boolean;
  debounceMs: number;
  maxBatchMs: number;
  cooldownMs: number;
  guideCooldownMs: number;
  guideMinChangeScore: number;
  guideWatchHandoff: boolean;
  largeChangeThreshold: number;
  maxQuestionContextChars: number;
  guideAutoReadDiff: boolean;
  maxDiffChars: number;
  keybinding: string;
  replyShortcuts: ReplyShortcutConfig;
  controlSocket: string;
  ignore: string[];
  watch: string[];
  diagnostics: DiagnosticSpec[];
  supervisorProvider?: string;
  supervisorModel?: string;
}

export interface ReplyShortcutConfig {
  detail: string;
  next: string;
  hint: string;
}

export interface GuidePlan {
  goal: string;
  stepNumber: number;
  lastObservedFiles: string[];
  lastHandoffAt?: number;
}

export interface FileSnapshot {
  path: string;
  exists: boolean;
  size: number;
  lines: number;
  hash: string;
  content?: string;
}

export interface ChangeFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  addedLines: number;
  deletedLines: number;
  changedBytes: number;
  lineRanges?: string[];
}

export interface ChangeSummary {
  root: string;
  source: ChangeSource;
  files: ChangeFile[];
  filesChanged: number;
  addedLines: number;
  deletedLines: number;
  changedBytes: number;
  createdFiles: number;
  deletedFiles: number;
  renamedFiles: number;
  directoriesChanged: number;
  concentration: number;
}

export interface ChangeScore {
  value: number;
  threshold: number;
  large: boolean;
  reasons: string[];
}

export interface QuestionEvidence {
  summary: ChangeSummary;
  score: ChangeScore;
  diagnostics: DiagnosticFailure[];
}

export interface DiagnosticFailure {
  name: string;
  command: string;
  exitCode: number | null;
  output: string;
}

export interface QuestionDraft {
  question: string;
  evidence: string[];
  category: "intent" | "boundary" | "failure" | "tradeoff" | "testing";
  context: string;
}

export interface PolicyDecision {
  action: "allow" | "block" | "confirm";
  reason: string;
  toolName: string;
}

export interface AuditRecord {
  timestamp: string;
  root: string;
  mode: SupervisionMode;
  toolName: string;
  toolCallId?: string;
  action: PolicyDecision["action"];
  reason: string;
}
