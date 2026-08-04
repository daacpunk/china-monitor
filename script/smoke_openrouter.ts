import assert from "node:assert";
import { MODEL_META } from "../server/analysis/llm";
import { estimateCost, PRICING, SERVICES } from "../server/costTracker";
import { LLM_MODEL_IDS, OPENROUTER_MODEL_IDS } from "../server/analysis/modelIds";

assert.equal(MODEL_META["or-glm-5.2"].provider, "openrouter");
assert.equal(MODEL_META["or-glm-5.2"].service, "openrouter");
assert.equal(MODEL_META["or-glm-5.2"].apiModel, "z-ai/glm-5.2");
assert.ok(SERVICES.includes("openrouter" as any));
const c = estimateCost("or-glm-5.2" as any, 1_000_000, 1_000_000);
assert.ok(c > 0, "cost must be non-zero");
assert.equal(c.toFixed(2), (0.76 + 2.42).toFixed(2));
for (const id of OPENROUTER_MODEL_IDS) {
  assert.ok((PRICING as any)[id], `missing pricing ${id}`);
  assert.equal(MODEL_META[id].provider, "openrouter");
  assert.ok(!MODEL_META[id].apiModel.includes("anthropic"));
  assert.ok(!MODEL_META[id].apiModel.includes("deepseek"));
}
assert.equal(LLM_MODEL_IDS.length, 14);
// direct providers untouched
assert.equal(MODEL_META["claude-sonnet-4"].apiModel, "claude-sonnet-4-6");
assert.equal(MODEL_META["deepseek-chat"].provider, "deepseek");
console.log("SMOKE OK — glm cost/MTok pair:", c);

/*
 * Run (needs no live key):
 *   npx esbuild script/smoke_openrouter.ts --bundle --platform=node --format=cjs --outfile=/tmp/smoke.cjs \
 *     && DATABASE_URL="postgres://u:p@127.0.0.1:5999/none" node /tmp/smoke.cjs
 */
