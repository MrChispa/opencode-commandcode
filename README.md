# opencode-commandcode

Connect **Command Code** to [OpenCode](https://opencode.ai) with a model list that **auto-syncs on every startup** and only shows models your plan can actually use.

## What it does

- Registers two `commandcode` custom providers (OpenAI-compatible + Anthropic).
- A [plugin](plugins/commandcode-models.ts) probes each model in the Command Code catalog on every OpenCode start, detects which ones your plan can use, and injects only the working ones.
- Claude models automatically use the Anthropic Messages endpoint (`/messages`); everything else uses OpenAI Chat Completions.
- The model list is cached to `~/.cache/opencode/commandcode-models.json`; if the API is unreachable, the last known good list is used.
- Your API key stays out of `opencode.json` — it lives in a private, `0600` file.

## How it works

| Step | What happens |
|------|--------------|
| 1 | Plugin fetches full catalog from `GET /provider/v1/models` (public, no key needed) |
| 2 | Each model is probed with a 1-token request to detect plan access + format |
| 3 | Working OpenAI-format models → injected into `commandcode` provider |
| 4 | Working Anthropic-format models (Claude) → injected into `commandcode-anthropic` |
| 5 | Models your plan can't access are silently dropped — they never appear in `/models` |

## Requirements

- OpenCode installed (≥ 1.18)
- A Command Code API key (starts with `user_`)

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
5. Merges both provider blocks into your `opencode.json`

Then **restart OpenCode**, open `/models` and choose a Command Code model.

## Upgrading an existing install

```bash
cd ~/projects/opencode-commandcode
git pull
cp plugins/commandcode-models.ts ~/.config/opencode/plugins/
```

The new model list syncs on next OpenCode restart.

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
        "apiKey": "{file:~/.config/opencode/secrets/commandcode-key}"
      }
    },
    "commandcode-anthropic": {
      "npm": "@ai-sdk/anthropic",
      "name": "Command Code (Claude)",
      "options": {
        "baseURL": "https://api.commandcode.ai/provider/v1",
        "apiKey": "{file:~/.config/opencode/secrets/commandcode-key}"
      }
    }
  }
}
```

**5.** Restart OpenCode and open `/models`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `401 Invalid 'Authorization' header` | Key file missing or wrong. Re-run install or update `~/.config/opencode/secrets/commandcode-key` |
| Command Code not in `/models` | Restart OpenCode so the plugin re-syncs |
| No new models after Command Code updates | Model list refreshes on startup. Restart OpenCode or delete `~/.cache/opencode/commandcode-models.json` |
| Claude models not working | Make sure `commandcode-anthropic` provider is configured and `@ai-sdk/anthropic` is installed |
| Some models missing from list | The plugin probed them and they returned `MODEL_NOT_IN_PLAN` — upgrade your Command Code plan |

## Security notes

- **Never commit your real API key.** This repo only carries the installer, plugin, and docs.
- The repo is **private** — add collaborators via GitHub → Settings → Collaborators.
- Why a separate secrets file: the OpenCode docs recommend `{file:path}` substitution so the provider works however you launch OpenCode (terminal, GUI, desktop).

## Layout

```
install.sh                        # one-command installer
plugins/commandcode-models.ts     # OpenCode plugin — probes & syncs models
opencode.json.example             # provider blocks for reference
```

## License

MIT
