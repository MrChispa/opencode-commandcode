/**
 * Command Code — dynamic model sync plugin
 *
 * Keeps the custom "commandcode" provider's model list in sync with
 * Command Code's API on every OpenCode startup, so opencode.json stays
 * minimal (npm/baseURL/apiKey only) and new models appear automatically.
 *
 * Flow:
 *   OpenCode startup → config hook → GET /provider/v1/models → inject
 *   provider.commandcode.models into the merged config.
 *
 * Auth note:
 *   The GET /models catalog endpoint is public (verified 200 without any
 *   key), so the model list syncs even when CMD_API_KEY is missing from the
 *   launching environment. The key is only required at chat time.
 *
 * Limit note:
 *   OpenCode's config schema requires limit.output whenever limit is
 *   present, and the Command Code API only publishes context_length (no
 *   max output tokens). Injecting a partial limit makes opencode refuse to
 *   start ("Missing key ... limit.output"), so model entries carry only a
 *   display name and opencode falls back to its default context budget.
 *
 * Resilience:
 *   On success the model list is cached to ~/.cache/opencode/commandcode-models.json.
 *   If the API is unreachable (offline, timeout, 5xx), the last cached
 *   list is used instead — the provider never loses its models on a hiccup.
 */

import type { Plugin } from "@opencode-ai/plugin"

// ─── Configuration ───────────────────────────────────────────────────────────

const BASE_URL = "https://api.commandcode.ai/provider/v1"
const CACHE_FILE = `${process.env.HOME ?? ""}/.cache/opencode/commandcode-models.json`
const FETCH_TIMEOUT_MS = 10_000

type ModelEntry = { name: string }

async function fetchModels(apiKey?: string): Promise<Record<string, ModelEntry>> {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE_URL}/models`, { headers, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { data?: Array<{ id: string; name?: string }> }
    const list = Array.isArray(body) ? body : body.data ?? []
    const models: Record<string, ModelEntry> = {}
    for (const m of list) {
      models[m.id] = { name: m.name || m.id }
    }
    return models
  } finally {
    clearTimeout(timer)
  }
}

async function readCache(): Promise<Record<string, ModelEntry> | null> {
  try {
    const file = Bun.file(CACHE_FILE)
    if (!(await file.exists())) return null
    const cached = (await file.json()) as Record<string, ModelEntry>
    return cached && Object.keys(cached).length > 0 ? cached : null
  } catch {
    return null
  }
}

async function writeCache(models: Record<string, ModelEntry>) {
  try {
    await Bun.write(CACHE_FILE, JSON.stringify(models, null, 2))
  } catch {
    // Non-fatal: the in-memory injection still works for this session.
  }
}

async function syncModels(apiKey?: string): Promise<{ models: Record<string, ModelEntry>; source: string; reason?: string }> {
  try {
    const models = await fetchModels(apiKey)
    if (Object.keys(models).length === 0) throw new Error("empty model list")
    await writeCache(models)
    return { models, source: "api" }
  } catch (err) {
    const cached = await readCache()
    if (cached) {
      return { models: cached, source: "cache", reason: err instanceof Error ? err.message : String(err) }
    }
    return { models: {}, source: "none", reason: err instanceof Error ? err.message : String(err) }
  }
}

export const CommandCodeModelsPlugin: Plugin = async ({ client }) => {
  return {
    config: async (cfg) => {
      const apiKey = process.env.CMD_API_KEY
      const result = await syncModels(apiKey)

      if (Object.keys(result.models).length === 0) {
        await client.app.log?.({
          body: {
            service: "commandcode-models",
            level: "error",
            message: "model sync failed and no cache is available",
            extra: { reason: result.reason },
          },
        })
        return
      }

      // Inject the synced list into the live merged config.
      if (!cfg.provider) cfg.provider = {}
      if (!cfg.provider.commandcode) cfg.provider.commandcode = {}
      cfg.provider.commandcode.models = result.models

      await client.app.log?.({
        body: {
          service: "commandcode-models",
          level: "info",
          message: `synced ${Object.keys(result.models).length} Command Code models from ${result.source}`,
          extra: result.reason ? { reason: result.reason } : undefined,
        },
      })
    },
  }
}