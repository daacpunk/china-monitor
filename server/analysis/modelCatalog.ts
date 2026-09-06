/**
 * LLM model catalog — single source of truth for selectable models, their API
 * ids, pricing and the current report default.
 *
 * Two layers:
 *   1. SEED_MODELS (this file) — always available, compiled in.
 *   2. Dynamic registry (settings key `llm_model_catalog`) — models discovered
 *      by modelCatalogRefresh.ts from Anthropic /v1/models. Registered entries
 *      are usable WITHOUT a redeploy, which is why route validation uses
 *      `isKnownLlmModel()` instead of a frozen `z.enum`.
 *
 * The report default lives in settings key `llm_default_report_model` and is
 * read via getDefaultReportModel() (async) / getDefaultReportModelSync()
 * (cached snapshot, primed at boot + after every write).
 *
 * Internal id vs API id: internal ids are stable forever so old strategy notes
 * and automation configs keep validating. `claude-sonnet-4` is kept as a legacy
 * internal id pointing at Anthropic's `claude-sonnet-4-6`.
 */

import { z } from "zod";
import { storage } from "../storage";

export type ModelProvider = "anthropic" | "deepseek" | "openrouter";
export type ModelTier = "default" | "cheap" | "frontier" | "legacy";
export type ModelService = "anthropic" | "deepseek" | "openrouter";

export interface ModelEntry {
  id: string;                 // internal, stable id (stored on notes/configs)
  label: string;              // display name
  provider: ModelProvider;
  apiModel: string;           // id sent to the provider API
  family: string;             // sonnet | opus | haiku | fable | deepseek | gpt | gemini | ...
  tier: ModelTier;
  inputPerMTok: number;
  outputPerMTok: number;
  selectable: boolean;
  source?: "seed" | "registered";
  registeredAt?: string;
  note?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed catalog
// Prices per MTok, USD, as of 2026-09-06.
//   Sonnet 5  $2/$10   https://platform.claude.com/docs/en/models/sonnet-5/whats-new-sonnet-5
//   Sonnet 4.6 $3/$15  (legacy, still active)
//   Opus 5    $5/$25   Haiku 4.5 $1/$5
// ─────────────────────────────────────────────────────────────────────────────

export const SEED_MODELS: ModelEntry[] = [
  // ── Anthropic (direct key) ──────────────────────────────────────────────
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "anthropic",
    apiModel: "claude-sonnet-5",
    family: "sonnet",
    tier: "default",
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    selectable: true,
    source: "seed",
  },
  {
    // Legacy internal id — kept FOREVER so previously stored notes/automation
    // configs still validate. Maps to Anthropic's `claude-sonnet-4-6`.
    id: "claude-sonnet-4",
    label: "Claude Sonnet 4.6 (legacy)",
    provider: "anthropic",
    apiModel: "claude-sonnet-4-6",
    family: "sonnet",
    tier: "legacy",
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    selectable: true,
    source: "seed",
  },
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    provider: "anthropic",
    apiModel: "claude-opus-5",
    family: "opus",
    tier: "frontier",
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    selectable: true,
    source: "seed",
  },
  {
    id: "claude-haiku-4",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    apiModel: "claude-haiku-4-5",
    family: "haiku",
    tier: "cheap",
    inputPerMTok: 0.8,
    outputPerMTok: 4.0,
    selectable: true,
    source: "seed",
  },
  // ── DeepSeek (direct key) ───────────────────────────────────────────────
  {
    id: "deepseek-chat",
    label: "DeepSeek Chat",
    provider: "deepseek",
    apiModel: "deepseek-chat",
    family: "deepseek",
    tier: "cheap",
    inputPerMTok: 0.27,
    outputPerMTok: 1.1,
    selectable: true,
    source: "seed",
  },
  {
    id: "deepseek-reasoner",
    label: "DeepSeek Reasoner",
    provider: "deepseek",
    apiModel: "deepseek-reasoner",
    family: "deepseek",
    tier: "frontier",
    inputPerMTok: 0.55,
    outputPerMTok: 2.19,
    selectable: true,
    source: "seed",
  },
  // ── OpenRouter (only models we have no direct key for) ──────────────────
  { id: "or-gpt-5.6", label: "GPT-5.6 (Sol)", provider: "openrouter", apiModel: "openai/gpt-5.6-sol", family: "gpt", tier: "frontier", inputPerMTok: 5.0, outputPerMTok: 30.0, selectable: true, source: "seed" },
  { id: "or-gpt-5.6-mini", label: "GPT-5.6 mini (Terra)", provider: "openrouter", apiModel: "openai/gpt-5.6-terra", family: "gpt", tier: "cheap", inputPerMTok: 1.0, outputPerMTok: 6.0, selectable: true, source: "seed" },
  { id: "or-gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "openrouter", apiModel: "google/gemini-2.5-pro", family: "gemini", tier: "frontier", inputPerMTok: 1.25, outputPerMTok: 10.0, selectable: true, source: "seed" },
  { id: "or-gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "openrouter", apiModel: "google/gemini-2.5-flash", family: "gemini", tier: "cheap", inputPerMTok: 0.3, outputPerMTok: 2.5, selectable: true, source: "seed" },
  { id: "or-grok-4.5", label: "Grok 4.5", provider: "openrouter", apiModel: "x-ai/grok-4.5", family: "grok", tier: "frontier", inputPerMTok: 2.0, outputPerMTok: 6.0, selectable: true, source: "seed" },
  { id: "or-glm-5.2", label: "GLM 5.2", provider: "openrouter", apiModel: "z-ai/glm-5.2", family: "glm", tier: "cheap", inputPerMTok: 0.76, outputPerMTok: 2.42, selectable: true, source: "seed" },
  { id: "or-kimi-k3", label: "Kimi K3", provider: "openrouter", apiModel: "moonshotai/kimi-k3", family: "kimi", tier: "frontier", inputPerMTok: 3.0, outputPerMTok: 15.0, selectable: true, source: "seed" },
  { id: "or-qwen-3.8-max", label: "Qwen 3.8 Max", provider: "openrouter", apiModel: "qwen/qwen3.8-max", family: "qwen", tier: "frontier", inputPerMTok: 2.0, outputPerMTok: 6.0, selectable: true, source: "seed" },
  { id: "or-minimax-m3", label: "MiniMax M3", provider: "openrouter", apiModel: "minimax/minimax-m3", family: "minimax", tier: "cheap", inputPerMTok: 0.3, outputPerMTok: 1.2, selectable: true, source: "seed" },
  { id: "or-llama-4-maverick", label: "Llama 4 Maverick", provider: "openrouter", apiModel: "meta-llama/llama-4-maverick", family: "llama", tier: "cheap", inputPerMTok: 0.2, outputPerMTok: 0.8, selectable: true, source: "seed" },
];

/** Compile-time default. The persisted override wins at runtime. */
export const DEFAULT_REPORT_MODEL = "claude-sonnet-5";

/** Cheap path default (commentary / classification) — unchanged by design. */
export const DEFAULT_CHEAP_MODEL = "claude-haiku-4";

export const SETTINGS_KEY_DEFAULT_MODEL = "llm_default_report_model";
export const SETTINGS_KEY_CATALOG = "llm_model_catalog";

const SEED_BY_ID = new Map(SEED_MODELS.map((m) => [m.id, m]));

export function serviceForProvider(provider: ModelProvider): ModelService {
  return provider;
}

// ─────────────────────────────────────────────────────────────────────────────
// Version parsing / comparison for Anthropic ids
//   claude-(sonnet|opus|haiku|fable)-MAJOR[-MINOR]   (missing MINOR = 0)
// ─────────────────────────────────────────────────────────────────────────────

export const ANTHROPIC_ID_RE = /^claude-(sonnet|opus|haiku|fable)-(\d+)(?:-(\d+))?$/;
/** Families we are allowed to auto-register (fable is deliberately excluded). */
export const AUTO_REGISTER_RE = /^claude-(sonnet|opus|haiku)-(\d+)(?:-(\d+))?$/;

/** A trailing 8-digit group is a release date (e.g. claude-sonnet-5-20260501). */
const SNAPSHOT_SUFFIX_RE = /-(\d{8})$/;

/** Split a dated snapshot id into its alias base + date. */
export function splitAnthropicSnapshot(id: string): { base: string; snapshot?: string } {
  const m = SNAPSHOT_SUFFIX_RE.exec(id.trim());
  if (!m) return { base: id.trim() };
  return { base: id.trim().slice(0, -m[0].length), snapshot: m[1] };
}

export interface AnthropicVersion {
  family: "sonnet" | "opus" | "haiku" | "fable";
  major: number;
  minor: number;
  /** Present when the id was a dated snapshot rather than a version alias. */
  snapshot?: string;
}

/**
 * Parse `claude-(sonnet|opus|haiku|fable)-MAJOR[-MINOR]`, tolerating a trailing
 * release date. Missing MINOR = 0. A date suffix is NOT read as a minor version
 * (otherwise `claude-sonnet-5-20260501` would outrank `claude-sonnet-5-1`).
 */
export function parseAnthropicVersion(id: string): AnthropicVersion | null {
  const { base, snapshot } = splitAnthropicSnapshot(id);
  const m = ANTHROPIC_ID_RE.exec(base);
  if (!m) return null;
  return {
    family: m[1] as AnthropicVersion["family"],
    major: Number(m[2]),
    minor: m[3] === undefined ? 0 : Number(m[3]),
    ...(snapshot ? { snapshot } : {}),
  };
}

/**
 * Compare two Anthropic model ids by version tuple only (family ignored).
 * Unparsable ids sort lowest. Returns -1 | 0 | 1.
 */
export function compareModelVersions(a: string, b: string): number {
  const va = parseAnthropicVersion(a);
  const vb = parseAnthropicVersion(b);
  if (!va && !vb) return 0;
  if (!va) return -1;
  if (!vb) return 1;
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  return 0;
}

/** True when `candidate` is a strictly newer version of the same family as `current`. */
export function isNewerSameFamily(candidate: string, current: string): boolean {
  const vc = parseAnthropicVersion(candidate);
  const vk = parseAnthropicVersion(current);
  if (!vc || !vk) return false;
  if (vc.family !== vk.family) return false;
  return compareModelVersions(candidate, current) > 0;
}

/** "claude-sonnet-5-1" -> "Claude Sonnet 5.1" */
export function labelForAnthropicId(id: string): string {
  const v = parseAnthropicVersion(id);
  if (!v) return id;
  const fam = v.family.charAt(0).toUpperCase() + v.family.slice(1);
  const version = v.minor ? `${v.major}.${v.minor}` : `${v.major}`;
  return `Claude ${fam} ${version}`;
}

/** Family default prices used when the provider payload carries no pricing. */
export function familyDefaultPricing(v: AnthropicVersion): { inputPerMTok: number; outputPerMTok: number } {
  switch (v.family) {
    case "sonnet":
      return v.major >= 5 ? { inputPerMTok: 2.0, outputPerMTok: 10.0 } : { inputPerMTok: 3.0, outputPerMTok: 15.0 };
    case "opus":
      return { inputPerMTok: 5.0, outputPerMTok: 25.0 };
    case "haiku":
      return { inputPerMTok: 1.0, outputPerMTok: 5.0 };
    default:
      // fable — never auto-registered, but keep a sane number for display.
      return { inputPerMTok: 15.0, outputPerMTok: 75.0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic registry state (settings-backed)
// ─────────────────────────────────────────────────────────────────────────────

export interface DetectedModel {
  provider: ModelProvider;
  id: string;                    // provider-side id/slug
  family?: string;
  reason: string;                // why it is only "detected" and not enabled
  createdAt?: string;
}

export interface CatalogState {
  refreshedAt?: string;
  anthropic: string[];           // raw ids returned by Anthropic
  openrouter: string[];          // raw slugs in tracked families
  registered: ModelEntry[];
  detected: DetectedModel[];
  lastPromotion?: { from: string; to: string; at: string };
  lastError?: string;
  notes?: string[];
}

export const EMPTY_CATALOG_STATE: CatalogState = {
  anthropic: [],
  openrouter: [],
  registered: [],
  detected: [],
};

let catalogCache: CatalogState = { ...EMPTY_CATALOG_STATE };
let catalogLoaded = false;
let defaultModelCache: string = DEFAULT_REPORT_MODEL;

function normalizeState(raw: any): CatalogState {
  if (!raw || typeof raw !== "object") return { ...EMPTY_CATALOG_STATE };
  return {
    refreshedAt: typeof raw.refreshedAt === "string" ? raw.refreshedAt : undefined,
    anthropic: Array.isArray(raw.anthropic) ? raw.anthropic.filter((x: any) => typeof x === "string") : [],
    openrouter: Array.isArray(raw.openrouter) ? raw.openrouter.filter((x: any) => typeof x === "string") : [],
    registered: Array.isArray(raw.registered)
      ? raw.registered.filter((m: any) => m && typeof m.id === "string" && typeof m.apiModel === "string")
      : [],
    detected: Array.isArray(raw.detected) ? raw.detected.filter((d: any) => d && typeof d.id === "string") : [],
    lastPromotion: raw.lastPromotion && typeof raw.lastPromotion === "object" ? raw.lastPromotion : undefined,
    lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
    notes: Array.isArray(raw.notes) ? raw.notes.filter((x: any) => typeof x === "string") : undefined,
  };
}

/** Read the persisted catalog (and refresh the sync snapshot). */
export async function loadCatalogState(force = false): Promise<CatalogState> {
  if (catalogLoaded && !force) return catalogCache;
  try {
    const row = await storage.getSetting(SETTINGS_KEY_CATALOG);
    catalogCache = normalizeState(row?.valueJson);
  } catch {
    // DB not reachable — seed-only mode is still fully functional.
    catalogCache = { ...EMPTY_CATALOG_STATE };
  }
  catalogLoaded = true;
  return catalogCache;
}

export async function saveCatalogState(state: CatalogState): Promise<CatalogState> {
  const clean = normalizeState(state);
  await storage.setSetting({ key: SETTINGS_KEY_CATALOG, valueJson: clean as any });
  catalogCache = clean;
  catalogLoaded = true;
  return clean;
}

/** Cached snapshot — safe in sync contexts (zod refine, MODEL_META proxy). */
export function getCatalogStateSync(): CatalogState {
  return catalogCache;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookups (seed + registry). Sync, backed by the cached snapshot.
// ─────────────────────────────────────────────────────────────────────────────

function registeredById(): Map<string, ModelEntry> {
  const m = new Map<string, ModelEntry>();
  for (const e of catalogCache.registered) m.set(e.id, { ...e, source: "registered" });
  return m;
}

/** Every known model: seed first, then registered extras. */
export function listAllModels(): ModelEntry[] {
  const out: ModelEntry[] = SEED_MODELS.map((m) => ({ ...m }));
  const seen = new Set(out.map((m) => m.id));
  registeredById().forEach((e) => {
    if (!seen.has(e.id)) {
      out.push(e);
      seen.add(e.id);
    }
  });
  return out;
}

/** Merged metadata for an internal model id (seed wins over registry). */
export function getModelMeta(id: string): ModelEntry | undefined {
  const seed = SEED_BY_ID.get(id);
  if (seed) return { ...seed };
  const reg = registeredById().get(id);
  return reg ? { ...reg } : undefined;
}

export function isKnownLlmModel(id: unknown): id is string {
  return typeof id === "string" && !!getModelMeta(id);
}

export function listSelectableModels(): ModelEntry[] {
  return listAllModels().filter((m) => m.selectable);
}

export function isSelectableLlmModel(id: unknown): boolean {
  const m = typeof id === "string" ? getModelMeta(id) : undefined;
  return !!m && m.selectable;
}

/** Catalog price lookup used by costTracker (seed + registered). */
export function getModelPricing(id: string): { inputPerMTok: number; outputPerMTok: number } | undefined {
  const m = getModelMeta(id);
  if (!m) return undefined;
  return { inputPerMTok: m.inputPerMTok, outputPerMTok: m.outputPerMTok };
}

// ─────────────────────────────────────────────────────────────────────────────
// Report default
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The current report default. Settings overlay wins; an unknown stored id
 * falls back to the seed default rather than exploding at generation time.
 */
export async function getDefaultReportModel(): Promise<string> {
  await loadCatalogState();
  let stored: string | undefined;
  try {
    const row = await storage.getSetting(SETTINGS_KEY_DEFAULT_MODEL);
    const val: any = row?.valueJson;
    if (val && typeof val === "object" && typeof val.model === "string") stored = val.model;
    else if (typeof val === "string") stored = val;
  } catch {
    /* fall through to seed default */
  }
  const resolved = stored && isKnownLlmModel(stored) ? stored : DEFAULT_REPORT_MODEL;
  defaultModelCache = resolved;
  return resolved;
}

/** Cached snapshot of the report default (primed at boot, updated on write). */
export function getDefaultReportModelSync(): string {
  return isKnownLlmModel(defaultModelCache) ? defaultModelCache : DEFAULT_REPORT_MODEL;
}

/** Persist the report default. Throws when the id is not known+selectable. */
export async function setDefaultReportModel(model: string): Promise<string> {
  await loadCatalogState();
  if (!isKnownLlmModel(model)) throw new Error(`Unknown model: ${model}`);
  if (!isSelectableLlmModel(model)) throw new Error(`Model not selectable: ${model}`);
  await storage.setSetting({ key: SETTINGS_KEY_DEFAULT_MODEL, valueJson: { model } as any });
  defaultModelCache = model;
  return model;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// Replaces `z.enum(LLM_MODEL_IDS)`: a runtime known-model check so models
// registered by the catalog refresher are accepted without a redeploy.
// ─────────────────────────────────────────────────────────────────────────────

export const llmModelSchema = z.string().superRefine((val, ctx) => {
  if (!isKnownLlmModel(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unknown model "${val}". Known models: ${listAllModels()
        .map((m) => m.id)
        .join(", ")}`,
    });
  }
});

/** Same as above but also requires the model to be selectable. */
export const selectableLlmModelSchema = z.string().superRefine((val, ctx) => {
  if (!isKnownLlmModel(val)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown model "${val}"` });
  } else if (!isSelectableLlmModel(val)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Model "${val}" is not selectable` });
  }
});

/** Boot-time prime so the sync snapshot and zod checks are warm. */
export async function primeModelCatalog(): Promise<void> {
  try {
    await loadCatalogState(true);
    await getDefaultReportModel();
  } catch (err) {
    console.error("[modelCatalog] prime failed (using seed defaults)", err);
  }
}
