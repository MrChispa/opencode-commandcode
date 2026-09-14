#!/usr/bin/env bash
#
# opencode-commandcode — installer
#
# Sets up Command Code as an OpenCode custom provider with auto-syncing models.
#   1. prompts for your Command Code API key (or reuses $CMD_API_KEY)
#   2. writes the key to a private 0600 file (for plugin probing)
#   3. copies the model-sync plugin into the OpenCode plugin dir
#   4. installs required npm dependencies (@ai-sdk/openai-compatible + @ai-sdk/anthropic)
#   5. merges the provider blocks into your opencode.json (with direct API key)
#
# Usage: ./install.sh        (then restart OpenCode, pick a model in /models)
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$REPO_DIR/plugins/commandcode-models.ts"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
SECRETS_DIR="$CONFIG_DIR/secrets"
SECRETS_FILE="$SECRETS_DIR/commandcode-key"
SECRETS_ABS="${SECRETS_FILE/#$HOME/\~}"

BASE_URL="https://api.commandcode.ai/provider/v1"

if [[ ! -f "$PLUGIN_SRC" ]]; then
  echo "ERROR: plugin file not found at $PLUGIN_SRC" >&2
  echo "Run this script from inside the cloned repo." >&2
  exit 1
fi

echo "==> 1/5 API key"
if [[ -z "${CMD_API_KEY:-}" ]]; then
  read -r -s -p "Paste your Command Code API key (starts with 'user_'): " CMD_API_KEY
  echo
fi
if [[ -z "${CMD_API_KEY:-}" ]]; then
  echo "ERROR: no API key provided." >&2
  exit 1
fi
CMD_API_KEY="$(printf '%s' "$CMD_API_KEY" | tr -d '[:space:]')"

echo "==> 2/5 secrets file"
mkdir -p "$SECRETS_DIR"
umask 077
printf '%s' "$CMD_API_KEY" > "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"
echo "  wrote ${SECRETS_FILE/#$HOME/\~} (chmod 600)"

echo "==> 3/5 plugin"
mkdir -p "$CONFIG_DIR/plugins"
cp "$PLUGIN_SRC" "$CONFIG_DIR/plugins/commandcode-models.ts"
echo "  copied -> ${CONFIG_DIR/#$HOME/\~}/plugins/commandcode-models.ts"

echo "==> 4/5 npm dependencies"
cd "$CONFIG_DIR"
if [[ ! -f package.json ]]; then
  cat > package.json <<'EOF'
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.18.18",
    "@ai-sdk/openai-compatible": "^3.0.48",
    "@ai-sdk/anthropic": "^4.0.53"
  }
}
EOF
  echo "  created package.json"
else
  echo "  package.json exists, ensuring dependencies..."
fi

if command -v bun &>/dev/null; then
  bun install 2>&1 | tail -3
elif command -v npm &>/dev/null; then
  npm install 2>&1 | tail -3
else
  echo "  WARNING: neither bun nor npm found. Install manually:"
  echo "    cd $CONFIG_DIR && bun install"
fi

echo "==> 5/5 provider config"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
if [[ -f "$CONFIG_FILE" ]]; then
  if python3 - "$CONFIG_FILE" "$BASE_URL" "$CMD_API_KEY" <<'PY'
import json, sys
config_file, base_url, api_key = sys.argv[1], sys.argv[2], sys.argv[3]
with open(config_file) as f:
    cfg = json.load(f)
provider = cfg.setdefault("provider", {})

# OpenAI-compatible provider (GPT, Qwen, Kimi, DeepSeek, etc.)
if "commandcode" in provider:
    provider["commandcode"].setdefault("options", {})
    provider["commandcode"]["options"]["baseURL"] = base_url
    provider["commandcode"]["options"]["apiKey"] = api_key
else:
    provider["commandcode"] = {
        "npm": "@ai-sdk/openai-compatible",
        "name": "Command Code",
        "options": {"baseURL": base_url, "apiKey": api_key},
    }

# Anthropic provider (Claude models — API requires /messages endpoint)
if "commandcode-anthropic" not in provider:
    provider["commandcode-anthropic"] = {
        "npm": "@ai-sdk/anthropic",
        "name": "Command Code (Claude)",
        "options": {"baseURL": base_url, "apiKey": api_key},
    }

with open(config_file, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
print("  merged commandcode + commandcode-anthropic into", config_file.replace(__import__("os").path.expanduser("~"), "~"))
PY
  then
    :
  else
    echo "ERROR: could not auto-merge opencode.json." >&2
    echo "Add both provider blocks manually — see opencode.json.example" >&2
    exit 1
  fi
else
  cat > "$CONFIG_FILE" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "commandcode": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Command Code",
      "options": {
        "baseURL": "$BASE_URL",
        "apiKey": "$CMD_API_KEY"
      }
    },
    "commandcode-anthropic": {
      "npm": "@ai-sdk/anthropic",
      "name": "Command Code (Claude)",
      "options": {
        "baseURL": "$BASE_URL",
        "apiKey": "$CMD_API_KEY"
      }
    }
  }
}
JSON
  echo "  created ${CONFIG_FILE/#$HOME/\~}"
fi

echo
echo "DONE. Restart OpenCode, then run /models and pick a Command Code model."
echo "The model list is probed automatically on startup — only models your plan"
echo "can actually use will appear. Claude models use the Anthropic endpoint."
