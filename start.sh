#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION="$ROOT_DIR/src/index.ts"
MODEL_CONFIG="${DUCK_AGENT_MODEL_CONFIG:-$ROOT_DIR/duck-agent.toml}"
KEY_FILE="${DUCK_AGENT_KEY_FILE:-${XDG_CONFIG_HOME:-${HOME}/.config}/duck-agent/api-key}"
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

# Parse the independent Duck model config at launch. The key file is
# intentionally never opened by this launcher; Pi reads it on request.
(
cd "$ROOT_DIR"
DUCK_AGENT_KEY_FILE="$KEY_FILE" node - "$MODEL_CONFIG" "$RUNTIME_MODELS" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

const [configPath, outputPath] = process.argv.slice(2);

function clean(value) {
  return String(value ?? "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

try {
  const parsed = parseToml(readFileSync(configPath, "utf8"));
  const source = parsed.model && typeof parsed.model === "object" ? parsed.model : parsed;
  const baseUrl = clean(source.base_url ?? source.baseUrl);
  const model = clean(typeof parsed.model === "string" ? parsed.model : source.model ?? source.model_id ?? source.modelId);
  const rawApi = clean(source.api ?? source.wire_api ?? source.wireApi).toLowerCase();
  const api = rawApi === "responses"
    ? "openai-responses"
    : rawApi === "completions"
      ? "openai-completions"
      : rawApi || "openai-completions";

  if (!baseUrl || !model) {
    throw new Error(`${configPath} must define base_url and model`);
  }
  if (api !== "openai-completions" && api !== "openai-responses") {
    throw new Error(`${configPath} api must be openai-completions or openai-responses`);
  }

  const config = {
    providers: {
      "duck-runtime": {
        name: "Duck runtime provider",
        baseUrl,
        api,
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
} catch (error) {
  process.stderr.write(`Duck Agent model config error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
NODE
)

export DUCK_AGENT_KEY_FILE="$KEY_FILE"
export PI_CODING_AGENT_DIR="$RUNTIME_DIR"

exec "$PI_BIN" \
  --extension "$EXTENSION" \
  --provider duck-runtime \
  --model "$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(c.providers["duck-runtime"].models[0].id)' "$RUNTIME_MODELS")" \
  "$@"
