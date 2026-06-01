/**
 * CEIC API Discovery Probe
 * ─────────────────────────
 * One-time probe to map the CEIC v2 API contract before building production
 * integrations. Tries a battery of common endpoint shapes + auth schemes
 * against the live API and reports what worked.
 *
 * Endpoint: GET /api/_probe/ceic?token=<PROBE_TOKEN>
 *   - PROBE_TOKEN must match env var CEIC_PROBE_TOKEN (set on Railway one-time)
 *   - Without the token, endpoint returns 403
 *   - Remove this file + route before Phase 2 final ship
 *
 * Cost impact: ~10-15 real CEIC calls, all logged to audit trail.
 */

const CEIC_BASE_CANDIDATES = [
  "https://api.ceicdata.com/v2",
  "https://api.ceicdata.com",
];

type ProbeResult = {
  url: string;
  method: string;
  auth: string;
  status: number | "error";
  statusText?: string;
  contentType?: string;
  bodyPreview: string;
  latencyMs: number;
  headers?: Record<string, string>;
};

async function probeOne(
  url: string,
  authHeader: { name: string; value: string } | null,
  method: "GET" | "POST" = "GET",
  body?: any,
): Promise<ProbeResult> {
  const start = Date.now();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (authHeader) headers[authHeader.name] = authHeader.value;
  if (body) headers["Content-Type"] = "application/json";

  try {
    const r = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    const respHeaders: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      // Keep only useful headers
      if (
        k.toLowerCase().includes("rate") ||
        k.toLowerCase().includes("quota") ||
        k.toLowerCase().includes("limit") ||
        k.toLowerCase().includes("ceic") ||
        k === "content-type"
      ) {
        respHeaders[k] = v;
      }
    });
    return {
      url,
      method,
      auth: authHeader ? authHeader.name : "none",
      status: r.status,
      statusText: r.statusText,
      contentType: r.headers.get("content-type") ?? undefined,
      bodyPreview: text.slice(0, 600),
      latencyMs: Date.now() - start,
      headers: respHeaders,
    };
  } catch (err: any) {
    return {
      url,
      method,
      auth: authHeader ? authHeader.name : "none",
      status: "error",
      bodyPreview: err.message ?? String(err),
      latencyMs: Date.now() - start,
    };
  }
}

export async function runCeicProbe(apiKey: string): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  // Auth scheme variants to try
  const authVariants = [
    { name: "Authorization", value: `Bearer ${apiKey}` },
    { name: "Authorization", value: `Token ${apiKey}` },
    { name: "x-api-key", value: apiKey },
    { name: "X-API-Key", value: apiKey },
    { name: "API-Key", value: apiKey },
  ];

  for (const base of CEIC_BASE_CANDIDATES) {
    // 1. Bare root  — what error / 401 do we get?
    results.push(await probeOne(base + "/", null));

    // 2. Common ping/me/auth-check endpoints
    for (const path of ["/series", "/databases", "/me", "/auth/whoami", "/calendar"]) {
      // First with no auth — captures 401 shape
      results.push(await probeOne(base + path, null));
      // Then with each auth variant — stop early if we get a 2xx
      for (const auth of authVariants) {
        const r = await probeOne(base + path, auth);
        results.push(r);
        if (typeof r.status === "number" && r.status >= 200 && r.status < 300) {
          // Found a working endpoint+auth — try a couple specific series IDs
          // to learn the series payload shape
          for (const seriesPath of [
            "/series/12345",
            "/series?id=12345",
            "/series?ids=12345",
            "/series/12345/data",
            "/series/12345/observations",
          ]) {
            results.push(await probeOne(base + seriesPath, auth));
          }
          break;
        }
      }
    }
  }

  return results;
}
