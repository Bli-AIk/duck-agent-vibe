#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION="$ROOT_DIR/src/index.ts"
INFO_FILE="${DUCK_AGENT_INFO_FILE:-/tmp/info.txt}"
KEY_FILE="${DUCK_AGENT_KEY_FILE:-${XDG_CONFIG_HOME:-${HOME}/.config}/duck-agent/api-key}"
CODEX_CONFIG="${DUCK_AGENT_CODEX_CONFIG:-${HOME}/.codex/config.toml}"
RUNTIME_DIR="$ROOT_DIR/.duck-runtime"
RUNTIME_MODELS="$RUNTIME_DIR/models.json"

# Keep the request-time key outside /tmp so it survives reboots. This only
# creates the file and changes its mode; its contents are never opened here.
KEY_PARENT_DIR="$(dirname "$KEY_FILE")"
mkdir -p "$KEY_PARENT_DIR"
if [[ ! -f "$KEY_FILE" ]]; then
  touch "$KEY_FILE"
fi
chmod 600 "$KEY_FILE"

if [[ -x "$ROOT_DIR/node_modules/.bin/pi" ]]; then
  PI_BIN="$ROOT_DIR/node_modules/.bin/pi"
elif command -v pi >/dev/null 2>&1; then
  PI_BIN="$(command -v pi)"
else
  echo "Pi is not installed. Installing this project's local dependencies..." >&2
  npm_config_cache="$ROOT_DIR/.npm-cache" npm --prefix "$ROOT_DIR" install --no-fund --no-audit
  PI_BIN="$ROOT_DIR/node_modules/.bin/pi"
fi

mkdir -p "$RUNTIME_DIR"

# Parse model metadata at launch without printing either source file. Codex's
# Provider config is authoritative when present. The key file is intentionally
# never opened by this launcher; Pi reads it on request.
(
cd "$ROOT_DIR"
DUCK_AGENT_KEY_FILE="$KEY_FILE" node - "$INFO_FILE" "$RUNTIME_MODELS" "$CODEX_CONFIG" <<'NODE'
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

const [infoPath, outputPath, codexConfigPath] = process.argv.slice(2);
let baseUrl;
let model;

function clean(value) {
  return String(value ?? "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function keyName(value) {
  return clean(value).toLowerCase().replace(/[\s_-]+/g, "");
}

function isUrlKey(value) {
  const normalized = keyName(value);
  return normalized === "api" || normalized.includes("url") || normalized.includes("endpoint") || normalized.includes("address") || normalized.includes("地址");
}

function isModelKey(value) {
  const normalized = keyName(value);
  return normalized.includes("model") || normalized.includes("模型");
}

function readCodexModel() {
  if (!codexConfigPath || !existsSync(codexConfigPath)) return undefined;
  try {
    const config = parseToml(readFileSync(codexConfigPath, "utf8"));
    const providerId = clean(config.model_provider);
    const provider = config.model_providers?.[providerId];
    const configuredModel = clean(config.model);
    const configuredUrl = clean(provider?.base_url);
    if (!configuredModel || !configuredUrl) return undefined;
    return {
      baseUrl: configuredUrl,
      model: configuredModel,
      api: clean(provider?.wire_api) === "responses" ? "openai-responses" : "openai-completions",
    };
  } catch {
    return undefined;
  }
}

const codexModel = readCodexModel();
if (codexModel) {
  baseUrl = codexModel.baseUrl;
  model = codexModel.model;
}

const raw = existsSync(infoPath) ? readFileSync(infoPath, "utf8").replace(/^\uFEFF/, "").trim() : "";

try {
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      const normalized = keyName(key);
      if (isUrlKey(normalized)) {
        baseUrl ??= clean(value);
      }
      if (isModelKey(normalized)) {
        model ??= clean(value);
      }
    }
  }
} catch {
  // The simple line-based formats below are also supported.
}

const lines = raw
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
const values = [];

for (const line of lines) {
  const match = line.match(/^([^=:]+?)\s*[:=]\s*(.+)$/);
  if (match) {
    const normalized = keyName(match[1]);
    const value = clean(match[2]);
    if (isUrlKey(normalized)) {
      baseUrl ??= value;
    } else if (isModelKey(normalized)) {
      model ??= value;
    } else {
      values.push(value);
    }
  } else {
    values.push(clean(line));
  }
}

if (!baseUrl) {
  baseUrl = values.find((value) => /^https?:\/\//i.test(value));
}
if (!baseUrl) {
  baseUrl = raw.match(/https?:\/\/[^\s,;]+/i)?.[0]?.replace(/[)\]}>'"]+$/, "");
}
if (!model) {
  model = values.find((value) => value && value !== baseUrl && !/^https?:\/\//i.test(value));
}
if (!model && baseUrl) {
  const remainder = raw.slice(raw.indexOf(baseUrl) + baseUrl.length).replace(/^[\s,;|]+/, "").trim();
  if (remainder && !remainder.includes("/")) model = clean(remainder);
}

if (!baseUrl || !model) {
  process.stderr.write("Duck Agent could not find an API URL and model name in the model info file.\n");
  process.exit(1);
}

const config = {
  providers: {
    "duck-runtime": {
      name: "Duck runtime provider",
      baseUrl,
      api: codexModel?.api ?? "openai-completions",
      apiKey: `!cat ${process.env.DUCK_AGENT_KEY_FILE ?? "/home/aik/.config/duck-agent/api-key"}`,
      models: [
        {
          id: model,
          name: model,
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 16384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    },
  },
};

writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE
)

export DUCK_AGENT_KEY_FILE="$KEY_FILE"
export PI_CODING_AGENT_DIR="$RUNTIME_DIR"

exec "$PI_BIN" \
  --extension "$EXTENSION" \
  --provider duck-runtime \
  --model "$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(c.providers["duck-runtime"].models[0].id)' "$RUNTIME_MODELS")" \
  "$@"
