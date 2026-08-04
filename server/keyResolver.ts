/**
 * resolveApiKey — env-var first, DB fallback.
 *
 * Railway deployments inject keys via env vars (preferred — never written to disk).
 * Sandbox/local dev falls back to the DB-stored keys from the Settings page.
 *
 * Returns null if neither source has a key.
 */
import { storage } from "./storage";

const ENV_MAP: Record<string, string> = {
  ceic: "CEIC_API_KEY",
  sonar: "SONAR_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  fred: "FRED_API_KEY",
};

export async function resolveApiKey(service: string): Promise<string | null> {
  const envName = ENV_MAP[service];
  if (envName && process.env[envName]) {
    return process.env[envName]!;
  }
  const row = await storage.getApiKey(service);
  return row?.apiKey ?? null;
}

export function keySourceFor(service: string): "env" | "db" | "missing" {
  const envName = ENV_MAP[service];
  if (envName && process.env[envName]) return "env";
  return "db"; // will return missing after resolveApiKey check
}
