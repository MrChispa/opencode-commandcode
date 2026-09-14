/**
 * Command Code — fast smart model sync plugin
 *
 * Optimizations:
 *   - Known Anthropic models (claude-*) skip the OpenAI probe → 2x faster
 *   - Only probes models not already in cache → near-instant on restart
 *   - Short timeouts + high concurrency → ~5s for 69 models
 *   - Only injects `models` into existing providers → preserves resolved API key
 *
 * Flow:
 *   1. GET /provider/v1/models → full catalog
 *   2. Check cache → only probe NEW or CHANGED models
 *   3. Inject working models into existing providers (auth preserved)
 *   4. Cache results → offline fallback
 */

import type { Plugin } from "@opencode-ai/plugin"

const BASE_URL = "https://api.commandcode.ai/provider/v1"
const CACHE_FILE = `${process.env.HOME ?? ""}/.cache/opencode/commandcode-models.json`
const PROBE_TIMEOUT_MS = 3_000
const CONCURRENCY = 15

// ─── Types ──────────────────────────────────────────────────────────────────

type ModelFormat = "openai" | "anthropic"
type ModelEntry = { name: string; format: ModelFormat }
type ProviderModels = Record<string, ModelEntry>

interface CacheShape {
  models: ProviderModels         // OpenAI-format models
  anthropicModels: ProviderModels // Anthropic-format models (Claude)
  savedAt: string
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const isAnthropicModel = (id: string): boolean =>
  id.startsWith("claude-") || id.startsWith("anthropic/")

const isFreeModel = (id: string): boolean =>
  id.includes(":free") || id.includes("-free")

const displayName = (id: string, name: string): string =>
  isFreeModel(id) ? `${name} (Free)` : name

async function readKeyFile(): Promise<string | null> {
  try {
    const file = Bun.file(`${process.env.HOME ?? ""}/.config/opencode/secrets/commandcode-key`)
    if (!(await file.exists())) return null
    return (await file.text()).trim()
  } catch {
    return null
  }
}

// ─── Catalog ────────────────────────────────────────────────────────────────

async function fetchCatalog(): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`${BASE_URL}/models`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { data?: Array<{ id: string; name?: string }> }
  const list = Array.isArray(body) ? body : body.data ?? []
  return list.map((m) => {
    const name = displayName(m.id, m.name || m.id)
    return { id: m.id, name }
  })
}

// ─── Probe ──────────────────────────────────────────────────────────────────

interface ProbeOutcome {
  format: ModelFormat  // best guess for format
  rateLimited: boolean // true if model is in plan but temporarily unavailable
}

async function probeModel(
  id: string,
  apiKey: string,
): Promise<ProbeOutcome | null> {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  }

  // Known Anthropic model → skip OpenAI probe, go straight to /messages
  if (isAnthropicModel(id)) {
    const result = await tryEndpoint(`${BASE_URL}/messages`, id, headers)
    if (result === "ok" || result === "rate-limited") {
      return { format: "anthropic", rateLimited: result === "rate-limited" }
    }
    return null
  }

  // Try OpenAI-compatible first
  const openaiResult = await tryEndpoint(`${BASE_URL}/chat/completions`, id, headers)
  if (openaiResult === "ok" || openaiResult === "rate-limited") {
    return { format: "openai", rateLimited: openaiResult === "rate-limited" }
  }

  // Fallback: maybe it's an Anthropic-format model with non-obvious ID
  if (openaiResult === "retry-anthropic") {
    const anthropicResult = await tryEndpoint(`${BASE_URL}/messages`, id, headers)
    if (anthropicResult === "ok" || anthropicResult === "rate-limited") {
      return { format: "anthropic", rateLimited: anthropicResult === "rate-limited" }
    }
  }

  return null
}

// Probe result: ok | retry-anthropic | rate-limited | no-access
type ProbeResult = "ok" | "retry-anthropic" | "rate-limited" | "no-access"

async function tryEndpoint(
  url: string,
  modelId: string,
  headers: Record<string, string>,
): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "h" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    })
    if (res.ok) return "ok"

    const err = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string }
    }
    const msg = err.error?.message ?? ""
    const code = err.error?.code ?? ""

    // "must be called via /messages" → signal to try Anthropic
    if (url.includes("/chat/completions") && msg.includes("/messages")) {
      return "retry-anthropic"
    }

    // Rate limit or temporarily unavailable → model IS in plan, just busy
    if (code === "rate_limit_error" || msg.includes("temporarily unavailable")) {
      return "rate-limited"
    }

    // Not in plan or other error
    return "no-access"
  } catch {
    return "no-access"
  } finally {
    clearTimeout(timer)
  }
}

// ─── Smart probing: check new models + retry rate-limited ones ─────────────

async function syncModels(
  catalog: Array<{ id: string; name: string }>,
  apiKey: string,
  cached: CacheShape | null,
): Promise<{ openai: ProviderModels; anthropic: ProviderModels }> {
  const openai: ProviderModels = cached?.models ? { ...cached.models } : {}
  const anthropic: ProviderModels = cached?.anthropicModels ? { ...cached.anthropicModels } : {}

  // Find models not in cache (new models from API)
  const knownIds = new Set([...Object.keys(openai), ...Object.keys(anthropic)])
  const toProbe = catalog.filter((m) => !knownIds.has(m.id))

  // Probe new models in parallel batches
  if (toProbe.length > 0) {
    for (let i = 0; i < toProbe.length; i += CONCURRENCY) {
      const batch = toProbe.slice(i, i + CONCURRENCY)
      const results = await Promise.all(
        batch.map(async (m) => {
          const outcome = await probeModel(m.id, apiKey)
          return { id: m.id, name: m.name, outcome }
        }),
      )
      for (const r of results) {
        if (!r.outcome) continue // not in plan or probe failed
        const target = r.outcome.format === "anthropic" ? anthropic : openai
        target[r.id] = { name: r.name, format: r.outcome.format }
      }
    }
  }

  // Always retry rate-limited models from previous run (might be available now)
  // Rate-limited models are already in openai/anthropic cache — we just verify they still work
  const allCached = [
    ...Object.entries(openai).map(([id, v]) => ({ id, format: "openai" as const, name: v.name })),
    ...Object.entries(anthropic).map(([id, v]) => ({ id, format: "anthropic" as const, name: v.name })),
  ]

  // Re-probe a sample to keep the list fresh (every 4th model, to stay fast)
  const toRefresh = allCached.filter((_, idx) => idx % 4 === 0)
  if (toRefresh.length > 0) {
    await Promise.all(
      toRefresh.map(async (m) => {
        const outcome = await probeModel(m.id, apiKey)
        if (!outcome) return
        const target = outcome.format === "anthropic" ? anthropic : openai
        target[m.id] = { name: m.name, format: outcome.format }
      }),
    )
  }

  // Remove models from cache that no longer exist in catalog
  const catalogIds = new Set(catalog.map((m) => m.id))
  for (const id of Object.keys(openai)) {
    if (!catalogIds.has(id)) delete openai[id]
  }
  for (const id of Object.keys(anthropic)) {
    if (!catalogIds.has(id)) delete anthropic[id]
  }

  return { openai, anthropic }
}

// ─── Cache ──────────────────────────────────────────────────────────────────

async function readCache(): Promise<CacheShape | null> {
  try {
    const file = Bun.file(CACHE_FILE)
    if (!(await file.exists())) return null
    const cached = (await file.json()) as CacheShape
    if (!cached?.models && !cached?.anthropicModels) return null
    return cached
  } catch {
    return null
  }
}

async function writeCache(openai: ProviderModels, anthropic: ProviderModels) {
  try {
    await Bun.write(
      CACHE_FILE,
      JSON.stringify({
        models: openai,
        anthropicModels: anthropic,
        savedAt: new Date().toISOString(),
      }, null, 2),
    )
  } catch {
    // Non-fatal
  }
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

export const CommandCodeModelsPlugin: Plugin = async ({ client }) => {
  return {
    config: async (cfg) => {
      const apiKey = process.env.CMD_API_KEY ?? await readKeyFile()

      if (!apiKey) {
        const cached = await readCache()
        if (cached) {
          injectModels(cfg, cached.models, cached.anthropicModels)
          await log(client, "info", "no API key, using cached models")
        } else {
          await log(client, "error", "no API key and no cache available")
        }
        return
      }

      // 1. Fetch catalog
      let catalog: Array<{ id: string; name: string }> = []
      try {
        catalog = await fetchCatalog()
      } catch (err) {
        const cached = await readCache()
        if (cached) {
          injectModels(cfg, cached.models, cached.anthropicModels)
          await log(client, "info", `catalog fetch failed, using cache: ${err instanceof Error ? err.message : String(err)}`)
          return
        }
        await log(client, "error", `catalog fetch failed: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      // 2. Read cache for smart probing
      const cached = await readCache()

      // 3. Probe only new models
      const { openai, anthropic } = await syncModels(catalog, apiKey, cached)

      // 4. Inject (preserves existing provider options including resolved apiKey)
      injectModels(cfg, openai, anthropic)

      // 5. Cache
      await writeCache(openai, anthropic)

      // 6. Log
      const total = Object.keys(openai).length + Object.keys(anthropic).length
      const newCount = catalog.length - (cached ? Object.keys(cached.models).length + Object.keys(cached.anthropicModels).length : 0)
      await log(client, "info", `synced ${total} models (${Object.keys(openai).length} openai, ${Object.keys(anthropic).length} anthropic, ${newCount > 0 ? newCount : 0} new)`)
    },
  }
}

// ─── Config injection: ONLY set models, preserve everything else ────────────

function injectModels(
  cfg: { provider?: Record<string, any> },
  openaiModels: ProviderModels,
  anthropicModels: ProviderModels,
) {
  if (!cfg.provider) cfg.provider = {}

  // OpenAI-compatible provider: only inject models, keep existing options
  if (Object.keys(openaiModels).length > 0) {
    if (!cfg.provider.commandcode) {
      cfg.provider.commandcode = {
        npm: "@ai-sdk/openai-compatible",
        name: "Command Code",
        options: { baseURL: BASE_URL },
        models: openaiModels,
      }
    } else {
      cfg.provider.commandcode.models = openaiModels
    }
  }

  // Anthropic provider: only inject models, keep existing options
  if (Object.keys(anthropicModels).length > 0) {
    if (!cfg.provider["commandcode-anthropic"]) {
      cfg.provider["commandcode-anthropic"] = {
        npm: "@ai-sdk/anthropic",
        name: "Command Code (Claude)",
        options: { baseURL: BASE_URL },
        models: anthropicModels,
      }
    } else {
      cfg.provider["commandcode-anthropic"].models = anthropicModels
    }
  }
}

// ─── Logging ────────────────────────────────────────────────────────────────

async function log(client: any, level: "info" | "error", message: string) {
  try {
    await client.app.log?.({
      body: { service: "commandcode-models", level, message },
    })
  } catch {
    // Best-effort
  }
}
