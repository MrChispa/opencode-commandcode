# opencode-commandcode

Connect **Command Code** (OpenAI-compatible) to [OpenCode](https://opencode.ai) with a model list that **auto-syncs on every startup** — no need to edit `opencode.json` when Command Code adds or removes models.

## What it does

- Registers a `commandcode` custom provider (`@ai-sdk/openai-compatible`).
- A [plugin](plugins/commandcode-models.ts) fetches the full model catalog from the Command Code API on each OpenCode start and injects it into your config.
- The provider's model list is cached to `~/.cache/opencode/commandcode-models.json`; if the API is unreachable (offline, timeout), the last known list is used so you never lose the provider.
- Your API key stays out of `opencode.json` — it lives in a private, `0600` file.

> The `GET /models` catalog endpoint is public (it does not require an API key), so the model list always syncs. The key is only needed when you actually chat.

## Requirements

- OpenCode installed
- A Command Code API key (starts with `user_`)

## Install (recommended)

```bash
git clone https://github.com/MrChispa/opencode-commandcode.git
cd opencode-commandcode
./install.sh
```

The installer:

1. Asks for your Command Code API key (or uses `$CMD_API_KEY` if already exported).
2. Writes the key to `~/.config/opencode/secrets/commandcode-key` (permissions `600`).
3. Copies `plugins/commandcode-models.ts` into your OpenCode plugin directory.
4. Merges the provider block into `~/.config/opencode/opencode.json` — preserving any existing providers and settings.

Then **restart OpenCode**, open `/models` and choose a Command Code model.

## Manual install

If you prefer to set it up by hand — or the installer could not merge your config properly — do the following:

**1. API key file**

```bash
mkdir -p ~/.config/opencode/secrets
umask 077
printf 'YOUR_KEY_HERE' > ~/.config/opencode/secrets/commandcode-key
chmod 600 ~/.config/opencode/secrets/commandcode-key
```

**2. Provider block** — add to `~/.config/opencode/opencode.json`:

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
    }
  }
}
```

**3. Plugin**

```bash
cp plugins/commandcode-models.ts ~/.config/opencode/plugins/
```

**4.** Restart OpenCode and open `/models`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `401 Invalid 'Authorization' header` | The key file at `~/.config/opencode/secrets/commandcode-key` is missing or wrong. Re-install or update that file. |
| Command Code does not appear in `/models` | Config was edited before the restart — quit and reopen OpenCode so it reloads the config and the plugin. |
| No new models after Command Code updates | Model list only refreshes on OpenCode startup (offline-first via cache). Restart OpenCode (or delete `~/.cache/opencode/commandcode-models.json`). |

## Security notes

- **Never commit your real API key.** This repo only carries the installer, the plugin and docs; your key lives only inside `~/.config/opencode/secrets/commandcode-key`.
- The repo is **private** — add friends as collaborators via GitHub → Settings → Collaborators, or clone over SSH with the URL above.
- Why a separate secrets file: the OpenCode docs recommend `{file:path}` substitution for API keys instead of `{env:VAR}`, so the provider works however you launch OpenCode (terminal, GUI, manager), and the key stays out of your main config.

## Layout

```
install.sh                      # one-command installer
plugins/commandcode-models.ts  # OpenCode plugin that syncs the model catalog
opencode.json.example         # hand-written provider block (for reference)
```