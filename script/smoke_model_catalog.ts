/**
 * Smoke tests for the LLM model catalog: version compare, seed invariants,
 * auto-registration rules and the Sonnet-only promotion policy.
 *
 * Pure functions only — no network, no DB writes.
 *
 * Run:
 *   npx esbuild script/smoke_model_catalog.ts --bundle --platform=node --format=cjs \
 *     --outfile=.smoke/catalog.cjs \
 *     && DATABASE_URL="postgres://u:p@127.0.0.1:5999/none" node .smoke/catalog.cjs
 */

import assert from "node:assert";
import {
  DEFAULT_REPORT_MODEL,
  SEED_MODELS,
  compareModelVersions,
  getModelMeta,
  getModelPricing,
  isKnownLlmModel,
  isNewerSameFamily,
  labelForAnthropicId,
  listSelectableModels,
  llmModelSchema,
  parseAnthropicVersion,
  type ModelEntry,
} from "../server/analysis/modelCatalog";
import {
  isRefreshDue,
  pickSonnetPromotion,
  planAnthropicRegistrations,
  planOpenRouterDetections,
} from "../server/analysis/modelCatalogRefresh";
import { MODEL_META } from "../server/analysis/llm";
import { estimateCost } from "../server/costTracker";

// ─── 1. Default + seed invariants ────────────────────────────────────────────
assert.equal(DEFAULT_REPORT_MODEL, "claude-sonnet-5", "report default must be Sonnet 5");
assert.equal(getModelMeta("claude-sonnet-5")!.apiModel, "claude-sonnet-5");
assert.equal(getModelMeta("claude-sonnet-5")!.inputPerMTok, 2);
assert.equal(getModelMeta("claude-sonnet-5")!.outputPerMTok, 10);

// Legacy id kept forever so previously stored notes/automation configs validate.
assert.ok(isKnownLlmModel("claude-sonnet-4"), "legacy claude-sonnet-4 must stay known");
assert.equal(getModelMeta("claude-sonnet-4")!.apiModel, "claude-sonnet-4-6");
assert.equal(getModelMeta("claude-sonnet-4")!.tier, "legacy");

// Opus 5 selectable, never the default.
assert.ok(isKnownLlmModel("claude-opus-5"));
assert.equal(getModelMeta("claude-opus-5")!.tier, "frontier");
assert.notEqual(DEFAULT_REPORT_MODEL, "claude-opus-5");
assert.equal(getModelMeta("claude-haiku-4")!.apiModel, "claude-haiku-4-5");

// Fable is not in the seed at all.
assert.ok(!SEED_MODELS.some((m) => m.family === "fable"), "fable must not be selectable");
assert.ok(listSelectableModels().length >= 16);

// ─── 2. Routing resolves through the catalog ─────────────────────────────────
assert.equal(MODEL_META["claude-sonnet-5"].apiModel, "claude-sonnet-5");
assert.equal(MODEL_META["claude-sonnet-5"].service, "anthropic");
assert.equal(MODEL_META["claude-sonnet-4"].apiModel, "claude-sonnet-4-6"); // legacy still routes
assert.equal(MODEL_META["or-glm-5.2"].apiModel, "z-ai/glm-5.2");
assert.equal(MODEL_META["nope-not-a-model"], undefined);

// Pricing comes from the catalog (Sonnet 5 is not in the frozen PRICING shape
// used by older code paths, but must still bill correctly).
assert.equal(estimateCost("claude-sonnet-5", 1_000_000, 1_000_000).toFixed(2), (2 + 10).toFixed(2));
assert.equal(getModelPricing("claude-opus-5")!.outputPerMTok, 25);

// ─── 3. Version compare ──────────────────────────────────────────────────────
assert.deepEqual(parseAnthropicVersion("claude-sonnet-5"), { family: "sonnet", major: 5, minor: 0 });
assert.deepEqual(parseAnthropicVersion("claude-sonnet-4-6"), { family: "sonnet", major: 4, minor: 6 });
assert.equal(parseAnthropicVersion("claude-3-5-sonnet-20241022"), null);
// A trailing release date is a snapshot, NOT a minor version.
assert.deepEqual(parseAnthropicVersion("claude-sonnet-5-20260501"), {
  family: "sonnet", major: 5, minor: 0, snapshot: "20260501",
});
assert.equal(compareModelVersions("claude-sonnet-5-20260501", "claude-sonnet-5"), 0);
assert.equal(compareModelVersions("claude-sonnet-5-20260501", "claude-sonnet-5-1"), -1);

const chain = ["claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-1", "claude-sonnet-6"];
for (let i = 0; i < chain.length - 1; i++) {
  assert.equal(compareModelVersions(chain[i], chain[i + 1]), -1, `${chain[i]} < ${chain[i + 1]}`);
  assert.equal(compareModelVersions(chain[i + 1], chain[i]), 1);
}
assert.equal(compareModelVersions("claude-sonnet-5", "claude-sonnet-5"), 0);
assert.ok(isNewerSameFamily("claude-sonnet-6", "claude-sonnet-5"));
assert.ok(!isNewerSameFamily("claude-opus-6", "claude-sonnet-5"), "cross-family is never 'newer'");
assert.equal(labelForAnthropicId("claude-sonnet-5-1"), "Claude Sonnet 5.1");
assert.equal(labelForAnthropicId("claude-opus-5"), "Claude Opus 5");

// ─── 4. Unknown model rejected by route validation ───────────────────────────
assert.ok(llmModelSchema.safeParse("claude-sonnet-5").success);
assert.ok(llmModelSchema.safeParse("claude-sonnet-4").success);
assert.ok(!llmModelSchema.safeParse("claude-sonnet-9").success, "unregistered id must be rejected");
assert.ok(!llmModelSchema.safeParse("gpt-42").success);

// ─── 5. Auto-registration rules ──────────────────────────────────────────────
const known = SEED_MODELS;
const listed = [
  "claude-sonnet-5",       // already known → skip
  "claude-sonnet-5-1",     // new sonnet → register
  "claude-opus-5-1",       // new opus → register (selectable, never default)
  "claude-haiku-5",        // new haiku → register
  "claude-fable-2",        // NEVER auto-register
  "claude-sonnet-7-20260901",   // dated snapshot → detect only, never registered
  "claude-3-5-sonnet-20241022", // legacy naming → ignore
];
const plan = planAnthropicRegistrations(listed, known);
const newIds = plan.entries.map((e) => e.id).sort();
assert.deepEqual(newIds, ["claude-haiku-5", "claude-opus-5-1", "claude-sonnet-5-1"]);
assert.ok(!newIds.includes("claude-fable-2"), "fable must never be auto-registered");
assert.ok(
  plan.detected.some((d) => d.id === "claude-fable-2"),
  "fable must be surfaced as detected-but-not-enabled",
);
assert.ok(
  plan.detected.some((d) => d.id === "claude-sonnet-7-20260901"),
  "dated snapshots are surfaced, not auto-registered",
);
assert.ok(!newIds.includes("claude-sonnet-7-20260901"));
const newSonnet = plan.entries.find((e) => e.id === "claude-sonnet-5-1")!;
assert.equal(newSonnet.apiModel, "claude-sonnet-5-1");
assert.equal(newSonnet.provider, "anthropic");
assert.equal(newSonnet.inputPerMTok, 2);   // sonnet major>=5 → $2/$10
assert.equal(newSonnet.outputPerMTok, 10);
assert.equal(plan.entries.find((e) => e.id === "claude-haiku-5")!.outputPerMTok, 5);
assert.equal(plan.entries.find((e) => e.id === "claude-opus-5-1")!.inputPerMTok, 5);

// ─── 6. OpenRouter is detect-only, never Anthropic/DeepSeek ──────────────────
const orDetected = planOpenRouterDetections(
  [
    "openai/gpt-6",
    "anthropic/claude-sonnet-5",   // forbidden: we hold a direct key
    "deepseek/deepseek-v4",        // forbidden: direct key
    "z-ai/glm-5.2",                // already tracked
    "some-vendor/unknown-model",   // untracked family
    "google/gemini-3-pro",
  ],
  known,
);
const orIds = orDetected.map((d) => d.id).sort();
assert.deepEqual(orIds, ["google/gemini-3-pro", "openai/gpt-6"]);
assert.ok(!orDetected.some((d) => d.id.startsWith("anthropic/")));
assert.ok(!orDetected.some((d) => d.id.startsWith("deepseek/")));

// ─── 7. Promotion policy: Sonnet only ────────────────────────────────────────
const withNewSonnet: ModelEntry[] = [...SEED_MODELS, newSonnet];
const liveIds = ["claude-sonnet-5-1", "claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-5"];

// newest sonnet wins
assert.equal(pickSonnetPromotion("claude-sonnet-5", withNewSonnet, liveIds), "claude-sonnet-5-1");
// legacy sonnet-4 promotes to the newest sonnet
assert.equal(pickSonnetPromotion("claude-sonnet-4", withNewSonnet, liveIds), "claude-sonnet-5-1");
// already newest → no promotion
assert.equal(pickSonnetPromotion("claude-sonnet-5-1", withNewSonnet, liveIds), null);
// never promote away from a non-sonnet default the user chose
assert.equal(pickSonnetPromotion("claude-opus-5", withNewSonnet, liveIds), null);
assert.equal(pickSonnetPromotion("claude-haiku-4", withNewSonnet, liveIds), null);
assert.equal(pickSonnetPromotion("or-gpt-5.6", withNewSonnet, liveIds), null);
assert.equal(pickSonnetPromotion("deepseek-reasoner", withNewSonnet, liveIds), null);

// never promote to opus/fable even when they are newer
const withNewOpusAndFable: ModelEntry[] = [
  ...SEED_MODELS,
  { ...newSonnet, id: "claude-opus-9", apiModel: "claude-opus-9", family: "opus", label: "Claude Opus 9" },
  { ...newSonnet, id: "claude-fable-9", apiModel: "claude-fable-9", family: "fable", label: "Claude Fable 9" },
];
assert.equal(
  pickSonnetPromotion("claude-sonnet-5", withNewOpusAndFable, ["claude-opus-9", "claude-fable-9", "claude-sonnet-5"]),
  null,
  "opus/fable must never become the report default",
);

// only trust ids Anthropic actually serves (when the fetch succeeded)
assert.equal(pickSonnetPromotion("claude-sonnet-5", withNewSonnet, ["claude-sonnet-5"]), null);
// Anthropic fetch failed (empty list) → fall back to what is registered
assert.equal(pickSonnetPromotion("claude-sonnet-5", withNewSonnet, []), "claude-sonnet-5-1");
// a dated snapshot proves the alias is served
assert.equal(
  pickSonnetPromotion("claude-sonnet-4", withNewSonnet, ["claude-sonnet-5-1-20260701"]),
  "claude-sonnet-5-1",
);

// ─── 8. 24h throttle ─────────────────────────────────────────────────────────
const now = Date.parse("2026-09-06T12:00:00Z");
assert.equal(isRefreshDue(undefined, now), true);
assert.equal(isRefreshDue("not-a-date", now), true);
assert.equal(isRefreshDue(new Date(now - 23 * 3600_000).toISOString(), now), false);
assert.equal(isRefreshDue(new Date(now - 25 * 3600_000).toISOString(), now), true);

console.log(
  `SMOKE OK — default=${DEFAULT_REPORT_MODEL}, seed=${SEED_MODELS.length} models, ` +
    `promotion+version+throttle policies verified`,
);
