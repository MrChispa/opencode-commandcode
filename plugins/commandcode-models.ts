/**
 * Command Code — smart model sync plugin
 *
 * Keeps the Command Code provider in sync with the user's actual plan and
 * the correct API format per model family.
 *
 * Flow on every OpenCode startup:
 *   1. GET /provider/v1/models  → full catalog
 *   2. Probe each model         → detect plan access + OpenAI vs Anthropic format
 *   3. Inject only working models into the appropriate provider config
 *   4. Cache results            → offline fallback uses last known good list
 *
 * Two providers are injected:
 *   - `commandcode`            → @ai-sdk/openai-compatible (GPT, Qwen, Kimi, etc.)
 *   - `commandcode-anthropic`  → @ai-sdk/anthropic (Claude models)
 *
 * Only models that the user's plan can actually use are injected, so /models
 * never shows models that would fail with MODEL_NOT_IN_PLAN.
 */

import type { Plugin } from "@opencode-ai/plugin"

// ─── Configuration ───────────────────────────────────────────────────────────

const BASE_URL = "https://api.commandcode.ai/provider/v1"
const CACHE_FILE = `${process.env.HOME ?? ""}/.cache/opencode/commandcode-models.json`
const FETCH_TIMEOUT_MS = 8_000
const PROBE_TIMEOUT_MS = 6_000
const PROBE_MAX_TOKENS = 1
const CONCURRENCY = 8

// ─── Types ──────────────────────────────────────────────────────────────────

type ModelFormat = "openai" | "anthropic"
type ModelEntry = { name: string; format: ModelFormat }
type ProviderModels = Record<string, ModelEntry>

interface CacheShape {
  models: ProviderModels
  anthropicModels: ProviderModels
  savedAt: string
}

// ─── Catalog fetch ──────────────────────────────────────────────────────────

async function fetchCatalog(): Promise<Array<{ id: string; name: string }>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE_URL}/models`, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { data?: Array<{ id: string; name?: string }> }
    const list = Array.isArray(body) ? body : body.data ?? []
    return list.map((m) => ({ id: m.id, name: m.name || m.id }))
  } finally {
    clearTimeout(timer)
  }
}

// ─── Model probe ────────────────────────────────────────────────────────────

async function probeModel(
  id: string,
  apiKey?: string,
): Promise<ModelFormat | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  // Try OpenAI-compatible first (cheaper, faster)
  const openaiFormat = await tryEndpoint(
    `${BASE_URL}/chat/completions`,
    {
      model: id,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: PROBE_MAX_TOKENS,
    },
    headers,
  )
  if (openaiFormat) return "openai"

  // If API explicitly says "use /messages", try Anthropic format
  const anthropicFormat = await tryEndpoint(
    `${BASE_URL}/messages`,
    {
      model: id,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: PROBE_MAX_TOKENS,
    },
    headers,
  )
  if (anthropicFormat) return "anthropic"

  return null
}

async function tryEndpoint(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (res.ok) return true

    // Parse error to distinguish "wrong endpoint" from "not in plan"
    const err = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string }
      message?: string
    }
    const msg = err.error?.message ?? err.message ?? ""
    const code = err.error?.code ?? ""

    // "must be called via /messages" → wrong endpoint, not a plan issue
    if (msg.includes("must be called via") || msg.includes("/messages")) {
      return false // signal to try anthropic
    }

    // MODEL_NOT_IN_PLAN or FORBIDDEN → not available, don't retry
    if (code === "FORBIDDEN" || msg.includes("MODEL_NOT_IN_PLAN")) {
      return false
    }

    // Rate limit or provider unavailable → might work later, but skip for now
    if (code === "rate_limit_error" || msg.includes("temporarily unavailable")) {
      return false
    }

    return false
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ─── Parallel probing with concurrency limit ────────────────────────────────

async function probeAllModels(
  catalog: Array<{ id: string; name: string }>,
  apiKey?: string,
): Promise<{ openai: ProviderModels; anthropic: ProviderModels }> {
  const openai: ProviderModels = {}
  const anthropic: ProviderModels = {}

  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < catalog.length; i += CONCURRENCY) {
    const batch = catalog.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (m) => {
        const format = await probeModel(m.id, apiKey)
        return { id: m.id, name: m.name, format }
      }),
    )

    for (const r of results) {
      if (r.format === "openai") {
        openai[r.id] = { name: r.name, format: "openai" }
      } else if (r.format === "anthropic") {
        anthropic[r.id] = { name: r.name, format: "anthropic" }
      }
      // null → not available in plan, skip
    }
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
    const data: CacheShape = {
      models: openai,
      anthropicModels: anthropic,
      savedAt: new Date().toISOString(),
    }
    await Bun.write(CACHE_FILE, JSON.stringify(data, null, 2))
  } catch {
    // Non-fatal: in-memory injection still works this session
  }
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

export const CommandCodeModelsPlugin: Plugin = async ({ client }) => {
  return {
    config: async (cfg) => {
      const apiKey = process.env.CMD_API_KEY

      // 1. Fetch catalog
      let catalog: Array<{ id: string; name: string }> = []
      try {
        catalog = await fetchCatalog()
      } catch (err) {
        const cached = await readCache()
        if (cached) {
          injectProviders(cfg, cached.models, cached.anthropicModels)
          await log(client, "info", `using cached models (catalog fetch failed: ${err instanceof Error ? err.message : String(err)})`)
          return
        }
        await log(client, "error", `catalog fetch failed, no cache available: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      if (catalog.length === 0) {
        await log(client, "error", "catalog returned empty model list")
        return
      }

      // 2. Probe all models
      const { openai, anthropic } = await probeAllModels(catalog, apiKey)

      // 3. If probing found nothing (e.g. network issues), fall back to cache
      const totalFound = Object.keys(openai).length + Object.keys(anthropic).length
      if (totalFound === 0) {
        const cached = await readCache()
        if (cached) {
          injectProviders(cfg, cached.models, cached.anthropicModels)
          await log(client, "info", "all probes failed, using cached models")
          return
        }
        await log(client, "error", "all model probes failed and no cache available")
        return
      }

      // 4. Inject into config
      injectProviders(cfg, openai, anthropic)

      // 5. Cache the results
      await writeCache(openai, anthropic)

      // 6. Log summary
      const parts = []
      if (Object.keys(openai).length > 0) parts.push(`${Object.keys(openai).length} OpenAI-format`)
      if (Object.keys(anthropic).length > 0) parts.push(`${Object.keys(anthropic).length} Anthropic-format`)
      await log(client, "info", `synced ${totalFound} models (${parts.join(", ")})`)
    },
  }
}

// ─── Config injection ───────────────────────────────────────────────────────

function injectProviders(
  cfg: { provider?: Record<string, any> },
  openaiModels: ProviderModels,
  anthropicModels: ProviderModels,
) {
  if (!cfg.provider) cfg.provider = {}

  // OpenAI-compatible provider (everything except Claude)
  if (Object.keys(openaiModels).length > 0) {
    cfg.provider.commandcode = {
      npm: "@ai-sdk/openai-compatible",
      name: "Command Code",
      options: {
        baseURL: BASE_URL,
        apiKey: "{file:~/.config/opencode/secrets/commandcode-key}",
      },
      models: openaiModels,
    }
  }

  // Anthropic provider (Claude models)
  if (Object.keys(anthropicModels).length > 0) {
    cfg.provider["commandcode-anthropic"] = {
      npm: "@ai-sdk/anthropic",
      name: "Command Code (Claude)",
      options: {
        baseURL: BASE_URL,
        apiKey: "{file:~/.config/opencode/secrets/commandcode-key}",
      },
      models: anthropicModels,
    }
  }
}

// ─── Logging helper ─────────────────────────────────────────────────────────

async function log(
  client: any,
  level: "info" | "error",
  message: string,
) {
  try {
    await client.app.log?.({
      body: {
        service: "commandcode-models",
        level,
        message,
      },
    })
  } catch {
    // Logging is best-effort
  }
}
