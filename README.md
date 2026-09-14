# opencode-commandcode

Connect **Command Code** to [OpenCode](https://opencode.ai) with a model list that **auto-syncs on every startup** and only shows models your plan can actually use.

## What it does

- Registers two `commandcode` custom providers (OpenAI-compatible + Anthropic).
- A [plugin](plugins/commandcode-models.ts) probes each model in the Command Code catalog on every OpenCode start, detects which ones your plan can use, and injects only the working ones.
- Claude models automatically use the Anthropic Messages endpoint (`/messages`); everything else uses OpenAI Chat Completions.
- Rate-limited models (e.g. DeepSeek when upstream is busy) still appear in the list — they're retried automatically each startup.
- Free-tier models (e.g. `LongCat 2.0 (Free)`) are labeled with a `(Free)` suffix in the model picker.
- The model list is cached to `~/.cache/opencode/commandcode-models.json`; if the API is unreachable, the last known good list is used.
- Your API key stays out of `opencode.json` — it lives in a private, `0600` file.

## How it works

| Step | What happens |
|------|--------------|
| 1 | Plugin fetches full catalog from `GET /provider/v1/models` (public, no key needed) |
| 2 | Reads cache from previous run — only probes **new** models not yet cached |
| 3 | Each model gets a 1-token probe to detect plan access + format |
| 4 | Claude models detected by ID prefix (`claude-*`) skip straight to `/messages` |
| 5 | Rate-limited models (temporarily unavailable) are included — re-probed periodically |
| 6 | Working OpenAI-format models → `commandcode` provider |
| 7 | Working Anthropic-format models (Claude) → `commandcode-anthropic` provider |
| 8 | Free-tier models (`:free` / `-free` in ID) get a `(Free)` suffix in the display name |
| 9 | Models your plan can't access are silently dropped |

### Startup performance

- **First run** (~5s): probes all 69 models in parallel batches of 15, 3s timeout each
- **Subsequent runs** (~1s): only probes new/unknown models, re-probes 25% of cache
- **Offline**: uses cached list instantly, no API calls

## Requirements

- OpenCode >= 1.18
- A Command Code API key (starts with `user_`)
- Bun (for running TypeScript plugins)

## Install

```bash
git clone https://github.com/MrChispa/opencode-commandcode.git
cd opencode-commandcode
./install.sh
```

The installer:
1. Asks for your API key (or uses `$CMD_API_KEY` if exported)
2. Writes the key to `~/.config/opencode/secrets/commandcode-key` (permissions `600`)
3. Copies the plugin into the OpenCode plugin directory
4. Installs required npm dependencies (`@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`)
5. Merges both provider blocks into your `opencode.json` with the API key set directly

Then **restart OpenCode**, open `/models` and choose a Command Code model.

## Upgrading

```bash
cd ~/Projects/opencode-commandcode
git pull
cp plugins/commandcode-models.ts ~/.config/opencode/plugins/
# Optional: clear cache to force full re-probe
rm ~/.cache/opencode/commandcode-models.txt
```

Restart OpenCode to apply.

## Manual install

If the installer can't merge your config:

**1. API key file**

```bash
mkdir -p ~/.config/opencode/secrets
umask 077
printf 'YOUR_KEY_HERE' > ~/.config/opencode/secrets/commandcode-key
chmod 600 ~/.config/opencode/secrets/commandcode-key
```

**2. Dependencies**

```bash
cd ~/.config/opencode
bun add @ai-sdk/openai-compatible @ai-sdk/anthropic
```

**3. Plugin**

```bash
cp plugins/commandcode-models.ts ~/.config/opencode/plugins/
```

**4. Provider blocks** — add to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "commandcode": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Command Code",
      "options": {
        "baseURL": "https://api.commandcode.ai/provider/v1",
        "apiKey": "YOUR_KEY_HERE"
      }
    },
    "commandcode-anthropic": {
      "npm": "@ai-sdk/anthropic",
      "name": "Command Code (Claude)",
      "options": {
        "baseURL": "https://api.commandcode.ai/provider/v1",
        "apiKey": "YOUR_KEY_HERE"
      }
    }
  }
}
```

**5.** Restart OpenCode and open `/models`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `401 Invalid 'Authorization' header` | API key missing or wrong. Re-run install or update `~/.config/opencode/secrets/commandcode-key` |
| Command Code not in `/models` | Restart OpenCode so the plugin re-syncs. Check `bun -e "await import('./plugins/commandcode-models.ts')"` for syntax errors |
| No new models after Command Code updates | Delete `~/.cache/opencode/commandcode-models.json` and restart |
| Claude models not working | Make sure `commandcode-anthropic` provider exists and `@ai-sdk/anthropic` is installed |
| Some models missing from list | They returned `MODEL_NOT_IN_PLAN` — upgrade your Command Code plan. Rate-limited models appear but may fail at chat time |
| Slow startup on first run | Normal — probing 69 models takes ~5s. Subsequent starts are faster (cache) |

## Architecture

### Two providers, one API

```
OpenCode
 ├── commandcode provider (@ai-sdk/openai-compatible)
 │    └── baseURL: https://api.commandcode.ai/provider/v1/chat/completions
 │    └── GPT, Qwen, Kimi, DeepSeek, Grok, Gemini, MiniMax...
 │
 └── commandcode-anthropic provider (@ai-sdk/anthropic)
      └── baseURL: https://api.commandcode.ai/provider/v1/messages
      └── Claude Sonnet, Opus, Haiku
```

The plugin detects format automatically: models with `claude-*` prefix use `/messages`, everything else tries `/chat/completions` first.

### Smart cache

```json
{
  "models": { "gpt-5.4": { "name": "GPT-5.4", "format": "openai" }, ... },
  "anthropicModels": { "claude-sonnet-5": { "name": "Claude Sonnet 5", "format": "anthropic" } },
  "savedAt": "2026-09-14T20:30:00.000Z"
}
```

On restart, only models NOT in the cache are probed. Every 4th cached model is re-probed to detect rate-limit recovery.

## Security notes

- **Never commit your real API key.** This repo only carries the installer, plugin, and docs.
- The repo is **private** — add collaborators via GitHub -> Settings -> Collaborators.
- Why a separate secrets file: keeps the key out of `opencode.json` and works however you launch OpenCode.

## Layout

```
install.sh                        # one-command installer
plugins/commandcode-models.ts     # OpenCode plugin — probes & syncs models
opencode.json.example             # provider blocks for reference
```

## License

MIT
