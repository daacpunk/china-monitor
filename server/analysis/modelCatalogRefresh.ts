/**
 * Dynamic model-catalog refresh — "new models get used".
 *
 * What it does on each run:
 *   1. GET https://api.anthropic.com/v1/models  (x-api-key + anthropic-version)
 *   2. GET https://openrouter.ai/api/v1/models  (optional Bearer)
 *   3. Auto-registers every Anthropic alias matching
 *      ^claude-(fable|opus|sonnet|haiku)-N(-N)?$ that we don't already know.
 *      Prices come from OpenRouter's public list (read only, never routed).
 *   4. Auto-registers the two newest base models per tracked OpenRouter vendor
 *      (pro, batch, image, audio, code and preview variants are only surfaced).
 *      Anthropic/DeepSeek are never routed via OpenRouter (we hold direct keys).
 *   5. Default policy (Settings): latest_anthropic (default), latest_openai, or
 *      pinned. Under a latest_* policy the report default follows the newest
 *      model on every refresh and notify() fires once per change.
 *
 * Failure policy: never fabricate a catalog. Missing keys / HTTP errors are
 * recorded in `lastError` + `notes` and the previous state is preserved.
 */

import { resolveApiKey } from "../keyResolver";
import { notify } from "../automation/notify";
import {
  compareModelVersions,
  familyDefaultPricing,
  getDefaultPolicy,
  getDefaultReportModel,
  getModelMeta,
  labelForAnthropicId,
  listAllModels,
  pickLatestAnthropic,
  pickLatestOpenAi,
  splitAnthropicSnapshot,
  loadCatalogState,
  parseAnthropicVersion,
  saveCatalogState,
  setDefaultReportModel,
  type DefaultPolicy,
  type CatalogState,
  type DetectedModel,
  type ModelEntry,
} from "./modelCatalog";

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 20_000;

/** OpenRouter vendor prefixes we already track via `or-*` seed entries. */
export const TRACKED_OPENROUTER_VENDORS = [
  "openai",
  "google",
  "x-ai",
  "z-ai",
  "moonshotai",
  "qwen",
  "minimax",
  "meta-llama",
] as const;

/** Vendors we must never route through OpenRouter (we hold direct keys). */
const FORBIDDEN_OPENROUTER_VENDORS = ["anthropic", "deepseek"];

export interface RefreshResult {
  ok: boolean;
  state: CatalogState;
  registeredNew: string[];
  promotion?: { from: string; to: string };
  skipped: string[];
}

function withTimeout(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms).unref?.();
  return c.signal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider fetches
// ─────────────────────────────────────────────────────────────────────────────

interface AnthropicListed { id: string; display_name?: string; created_at?: string }

export async function fetchAnthropicModels(apiKey: string): Promise<AnthropicListed[]> {
  const res = await fetch(ANTHROPIC_MODELS_URL, {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    signal: withTimeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic /v1/models HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json: any = await res.json();
  const data = Array.isArray(json?.data) ? json.data : [];
  return data
    .filter((m: any) => typeof m?.id === "string")
    .map((m: any) => ({ id: m.id, display_name: m.display_name, created_at: m.created_at }));
}

export interface OpenRouterListed { id: string; name?: string; created?: number; pricing?: { prompt?: string; completion?: string } }

export async function fetchOpenRouterModels(apiKey?: string | null): Promise<OpenRouterListed[]> {
  const res = await fetch(OPENROUTER_MODELS_URL, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: withTimeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter /api/v1/models HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json: any = await res.json();
  const data = Array.isArray(json?.data) ? json.data : [];
  return data.filter((m: any) => typeof m?.id === "string");
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide which Anthropic ids to auto-register.
 * - must match claude-(sonnet|opus|haiku)-MAJOR[-MINOR]
 * - fable never qualifies (it matches ANTHROPIC_ID_RE but not AUTO_REGISTER_RE)
 * - must not collide with a seed/registered internal id OR an already-used apiModel
 */
export function planAnthropicRegistrations(
  anthropicIds: string[],
  known: ModelEntry[],
  prices: Map<string, { inputPerMTok: number; outputPerMTok: number }> = new Map(),
): { entries: ModelEntry[]; detected: DetectedModel[] } {
  const knownIds = new Set(known.map((m) => m.id));
  const knownApiModels = new Set(known.map((m) => m.apiModel));
  const entries: ModelEntry[] = [];
  const detected: DetectedModel[] = [];
  const now = new Date().toISOString();

  for (const id of anthropicIds) {
    const parsed = parseAnthropicVersion(id);
    if (!parsed) continue; // legacy/unrelated naming: ignore

    // Dated snapshots (claude-sonnet-5-20260501) are not registered: we prefer
    // the version alias and never invent one. Surfaced for manual enablement.
    if (parsed.snapshot) {
      const base = splitAnthropicSnapshot(id).base;
      if (!knownApiModels.has(id) && !knownApiModels.has(base)) {
        detected.push({
          provider: "anthropic",
          id,
          family: parsed.family,
          reason: "dated snapshot — enable manually (auto-registration only tracks version aliases)",
          createdAt: now,
        });
      }
      continue;
    }

    if (knownIds.has(id) || knownApiModels.has(id)) continue;

    const price = prices.get(anthropicOpenRouterSlug(id)) ?? familyDefaultPricing(parsed);
    entries.push({
      id,
      label: labelForAnthropicId(id),
      provider: "anthropic",
      apiModel: id,
      family: parsed.family,
      tier: parsed.family === "haiku" ? "cheap" : parsed.family === "sonnet" ? "default" : "frontier",
      inputPerMTok: price.inputPerMTok,
      outputPerMTok: price.outputPerMTok,
      selectable: true,
      source: "registered",
      registeredAt: now,
      note: "auto-registered from Anthropic /v1/models",
    });
    knownIds.add(id);
    knownApiModels.add(id);
  }
  return { entries, detected };
}

/** claude-fable-5-2 -> anthropic/claude-fable-5.2 (OpenRouter's naming, used for prices only). */
export function anthropicOpenRouterSlug(id: string): string {
  return "anthropic/" + id.replace(/^(claude-[a-z]+-\d+)-(\d+)$/, "$1.$2");
}

/** Per-MTok USD prices from OpenRouter's public list, keyed by slug. Skips :variant rows. */
export function openRouterPrices(listed: OpenRouterListed[]): Map<string, { inputPerMTok: number; outputPerMTok: number }> {
  const out = new Map<string, { inputPerMTok: number; outputPerMTok: number }>();
  for (const m of listed) {
    if (m.id.includes(":")) continue;
    const i = Number(m.pricing?.prompt), o = Number(m.pricing?.completion);
    if (!Number.isFinite(i) || !Number.isFinite(o) || (i === 0 && o === 0)) continue;
    out.set(m.id, { inputPerMTok: Math.round(i * 1e6 * 1000) / 1000, outputPerMTok: Math.round(o * 1e6 * 1000) / 1000 });
  }
  return out;
}

const OR_FAMILY: Record<string, string> = {
  openai: "gpt", google: "gemini", "x-ai": "grok", "z-ai": "glm", moonshotai: "kimi",
  qwen: "qwen", minimax: "minimax", "meta-llama": "llama",
};
/** Variants that are not general text models, or are not the base release. */
const OR_EXCLUDE = /(:|-pro$|-image|-audio|code|guard|safeguard|embed|-vl|omni|lyria|banana|gemma|chat-latest|customtools|preview|live|tts|-build|multi-agent|oss|legal|\d+b(-|$)|\d+t-|-0\d{3}$|-\d{8}$|:free)/i;
const OR_REGISTER_PER_VENDOR = 2;

/**
 * Register the newest base models per tracked vendor so the picker is never a
 * generation behind. Prices come from the listing itself.
 */
export function planOpenRouterRegistrations(listed: OpenRouterListed[], known: ModelEntry[]): ModelEntry[] {
  const knownApi = new Set(known.map((m) => m.apiModel.toLowerCase()));
  const knownIds = new Set(known.map((m) => m.id));
  const out: ModelEntry[] = [];
  const now = new Date().toISOString();
  for (const vendor of TRACKED_OPENROUTER_VENDORS) {
    const pool = listed
      .filter((m) => m.id.toLowerCase().startsWith(vendor + "/") && !OR_EXCLUDE.test(m.id.slice(vendor.length + 1)))
      .filter((m) => Number(m.pricing?.completion) > 0)
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .slice(0, OR_REGISTER_PER_VENDOR);
    for (const m of pool) {
      const lower = m.id.toLowerCase();
      const id = "or-" + m.id.replace("/", "-");
      if (knownApi.has(lower) || knownIds.has(id)) continue;
      const price = openRouterPrices([m]).get(m.id);
      if (!price) continue;
      out.push({
        id,
        label: (m.name ?? m.id).replace(/^[^:]+:\s*/, ""),
        provider: "openrouter",
        apiModel: m.id,
        family: OR_FAMILY[vendor] ?? vendor,
        tier: price.outputPerMTok <= 3 ? "cheap" : "frontier",
        inputPerMTok: price.inputPerMTok,
        outputPerMTok: price.outputPerMTok,
        selectable: true,
        source: "registered",
        registeredAt: now,
        createdAt: m.created,
        note: "auto-registered from OpenRouter /models",
      });
      knownApi.add(lower);
      knownIds.add(id);
    }
  }
  return out;
}

/**
 * OpenRouter: detect-only. Surface slugs in tracked families that we don't
 * already route to, so a human can decide. Never Anthropic/DeepSeek.
 */
export function planOpenRouterDetections(
  listed: OpenRouterListed[],
  known: ModelEntry[],
): DetectedModel[] {
  const knownApiModels = new Set(
    known.filter((m) => m.provider === "openrouter").map((m) => m.apiModel.toLowerCase()),
  );
  const out: DetectedModel[] = [];
  const now = new Date().toISOString();
  const recent = [...listed].sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  for (const m of recent) {
    const lower = m.id.toLowerCase();
    const vendor = lower.split("/")[0];
    if (FORBIDDEN_OPENROUTER_VENDORS.includes(vendor)) continue; // direct keys only
    if (!TRACKED_OPENROUTER_VENDORS.includes(vendor as any)) continue;
    if (lower.includes(":")) continue; // batch / free variants
    if (knownApiModels.has(lower)) continue;
    out.push({
      provider: "openrouter",
      id: m.id,
      family: vendor,
      reason: "recent model not auto-registered (pro, image, audio, code or older release) — enable manually",
      createdAt: now,
    });
    if (out.length >= 15) break;
  }
  return out;
}

/**
 * Sonnet-only promotion policy.
 *
 * @param currentDefault current report default (internal id)
 * @param models         seed + registered entries
 * @param anthropicIds   ids Anthropic returned this run (empty when the fetch failed)
 * @returns the internal id to promote to, or null
 */
export function pickSonnetPromotion(
  currentDefault: string,
  models: ModelEntry[],
  anthropicIds: string[],
): string | null {
  const currentMeta = models.find((m) => m.id === currentDefault);
  // Only promote when we're already on a Sonnet (legacy `claude-sonnet-4` counts).
  const currentIsSonnet = currentMeta?.family === "sonnet" || currentDefault === "claude-sonnet-4";
  if (!currentIsSonnet) return null;

  // Accept both version aliases and dated snapshots as evidence that a model is
  // served (claude-sonnet-5-20260501 implies claude-sonnet-5 is live).
  const live = new Set<string>();
  for (const id of anthropicIds) {
    live.add(id);
    live.add(splitAnthropicSnapshot(id).base);
  }
  const sonnets = models.filter(
    (m) =>
      m.provider === "anthropic" &&
      m.family === "sonnet" &&
      m.selectable &&
      // If Anthropic answered, only trust ids it actually serves; if the fetch
      // failed we fall back to what is already registered.
      (live.size === 0 || live.has(m.apiModel)),
  );
  if (sonnets.length === 0) return null;

  let best = sonnets[0];
  for (const m of sonnets.slice(1)) {
    if (compareModelVersions(m.apiModel, best.apiModel) > 0) best = m;
  }

  const currentApi = currentMeta?.apiModel ?? currentDefault;
  if (compareModelVersions(best.apiModel, currentApi) <= 0) return null;
  if (best.id === currentDefault) return null;
  return best.id;
}

/** Policy-driven promotion. Returns the internal id to switch to, or null. */
export function pickDefaultPromotion(
  policy: DefaultPolicy,
  currentDefault: string,
  models: ModelEntry[],
  anthropicIds: string[],
): string | null {
  if (policy === "pinned") return null;
  const live = new Set<string>();
  for (const id of anthropicIds) {
    live.add(id);
    live.add(splitAnthropicSnapshot(id).base);
  }
  const best = policy === "latest_openai" ? pickLatestOpenAi(models) : pickLatestAnthropic(models, live);
  return best && best.id !== currentDefault ? best.id : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────────────

export async function refreshModelCatalog(
  opts: { trigger?: "manual" | "scheduler" | "boot" } = {},
): Promise<RefreshResult> {
  const trigger = opts.trigger ?? "manual";
  const prev = await loadCatalogState(true);
  const notes: string[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];

  // 1. Anthropic
  let anthropicIds: string[] = [];
  const anthropicKey = await resolveApiKey("anthropic");
  if (!anthropicKey) {
    skipped.push("anthropic");
    notes.push("Anthropic skipped: no ANTHROPIC_API_KEY (env or Settings).");
  } else {
    try {
      const listed = await fetchAnthropicModels(anthropicKey);
      anthropicIds = listed.map((m) => m.id);
      notes.push(`Anthropic returned ${anthropicIds.length} models.`);
    } catch (err: any) {
      errors.push(`Anthropic: ${err?.message ?? String(err)}`);
    }
  }

  // 2. OpenRouter
  let openrouterSlugs: string[] = [];
  let openrouterListed: OpenRouterListed[] = [];
  const orKey = await resolveApiKey("openrouter");
  {
    try {
      const listed = await fetchOpenRouterModels(orKey);
      openrouterListed = listed;
      openrouterSlugs = listed.map((m) => m.id);
      notes.push(`OpenRouter returned ${openrouterSlugs.length} models.`);
    } catch (err: any) {
      errors.push(`OpenRouter: ${err?.message ?? String(err)}`);
    }
  }

  // 3/4. Register + detect
  const known = listAllModels();
  const prices = openRouterPrices(openrouterListed);
  const { entries: anthropicEntries, detected: anthropicDetected } = planAnthropicRegistrations(
    anthropicIds,
    known,
    prices,
  );
  const orEntries = planOpenRouterRegistrations(openrouterListed, [...known, ...anthropicEntries]);
  const newEntries = [...anthropicEntries, ...orEntries];

  const registered: ModelEntry[] = [...prev.registered];
  const registeredIds = new Set(registered.map((m) => m.id));
  const registeredNew: string[] = [];
  // Re-price Anthropic entries registered earlier from the live list.
  for (const e of registered) {
    if (e.provider !== "anthropic") continue;
    const p = prices.get(anthropicOpenRouterSlug(e.apiModel));
    if (p) { e.inputPerMTok = p.inputPerMTok; e.outputPerMTok = p.outputPerMTok; }
    const v = parseAnthropicVersion(e.apiModel);
    if (v?.family === "fable" && e.tier !== "frontier") e.tier = "frontier";
  }
  for (const e of newEntries) {
    if (registeredIds.has(e.id)) continue;
    registered.push(e);
    registeredIds.add(e.id);
    registeredNew.push(e.id);
  }

  const nextState: CatalogState = {
    refreshedAt: new Date().toISOString(),
    anthropic: anthropicIds.length ? anthropicIds : prev.anthropic,
    openrouter: openrouterSlugs.length ? openrouterSlugs : prev.openrouter,
    registered,
    detected: [...anthropicDetected, ...planOpenRouterDetections(openrouterListed, [...known, ...newEntries])],
    lastPromotion: prev.lastPromotion,
    lastError: errors.length ? errors.join(" | ") : undefined,
    notes,
  };
  await saveCatalogState(nextState);

  // 5. Default policy: follow the newest model unless the operator pinned one.
  let promotion: { from: string; to: string } | undefined;
  try {
    const policy = await getDefaultPolicy();
    const currentDefault = await getDefaultReportModel();
    const target = pickDefaultPromotion(policy, currentDefault, listAllModels(), anthropicIds);
    if (target) {
      await setDefaultReportModel(target);
      const fromLabel = getModelMeta(currentDefault)?.label ?? currentDefault;
      const toLabel = getModelMeta(target)?.label ?? target;
      promotion = { from: currentDefault, to: target };
      nextState.lastPromotion = { from: currentDefault, to: target, at: new Date().toISOString() };
      await saveCatalogState(nextState);
      await notify({
        title: `Report default updated: ${fromLabel} → ${toLabel}`,
        body:
          `The default synthesis model for strategy reports now follows the newest model ` +
          `(policy: ${policy}, trigger: ${trigger}). Change the policy or pin a model on ` +
          `Settings → API Keys → Models.`,
        kind: "info",
        link: "/settings",
      });
    }
  } catch (err: any) {
    const msg = `promotion: ${err?.message ?? String(err)}`;
    errors.push(msg);
    nextState.lastError = errors.join(" | ");
    await saveCatalogState(nextState).catch(() => undefined);
  }

  return { ok: errors.length === 0, state: nextState, registeredNew, promotion, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// 24h throttle (scheduler). The Settings button bypasses this.
// ─────────────────────────────────────────────────────────────────────────────

const THROTTLE_MS = 24 * 60 * 60 * 1000;

export function isRefreshDue(refreshedAt: string | undefined, now = Date.now()): boolean {
  if (!refreshedAt) return true;
  const t = Date.parse(refreshedAt);
  if (!Number.isFinite(t)) return true;
  return now - t >= THROTTLE_MS;
}

/** Called from the scheduler's 15-min tick; runs at most once per 24h. */
export async function maybeRefreshModelCatalog(): Promise<"ran" | "throttled" | "error"> {
  try {
    const state = await loadCatalogState(true);
    if (!isRefreshDue(state.refreshedAt)) return "throttled";
    const res = await refreshModelCatalog({ trigger: "scheduler" });
    if (res.registeredNew.length) {
      console.log(`[modelCatalog] registered new models: ${res.registeredNew.join(", ")}`);
    }
    return "ran";
  } catch (err) {
    console.error("[modelCatalog] scheduled refresh failed (non-fatal)", err);
    return "error";
  }
}
