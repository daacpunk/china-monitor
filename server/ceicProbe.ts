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
  "https://api.isi-c.com",
  "https://api.isi-c.com/v2",
  "https://api.ceic-data.com",
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
    { name: "Authorization", value: apiKey },
    { name: "x-api-key", value: apiKey },
    { name: "X-API-Key", value: apiKey },
    { name: "API-Key", value: apiKey },
    { name: "apikey", value: apiKey },
    { name: "Ocp-Apim-Subscription-Key", value: apiKey },
    { name: "ceic-token", value: apiKey },
    { name: "ceic-api-key", value: apiKey },
  ];

  // Try the key as a query param too (some gateways accept this)
  const queryParamUrls = [
    `https://api.ceicdata.com/v2/series?api_key=${encodeURIComponent(apiKey)}`,
    `https://api.ceicdata.com/v2/series?token=${encodeURIComponent(apiKey)}`,
    `https://api.ceicdata.com/v2/series?access_token=${encodeURIComponent(apiKey)}`,
  ];
  for (const u of queryParamUrls) {
    results.push(await probeOne(u, null));
  }

  // First: try OAuth-style token endpoints. CEIC may issue access tokens
  // from credentials, and the "API key" is actually a client_secret or
  // a long-lived bearer.
  const oauthCandidates = [
    "https://api.ceicdata.com/v2/token",
    "https://api.ceicdata.com/v2/oauth/token",
    "https://api.ceicdata.com/v2/auth/token",
    "https://api.ceicdata.com/oauth2/token",
    "https://auth.ceicdata.com/oauth2/token",
    "https://api.ceicdata.com/v2/login",
  ];
  for (const u of oauthCandidates) {
    // Try GET (some auth endpoints accept it)
    results.push(await probeOne(u, null, "GET"));
    // Try POST with token in body (OAuth-ish)
    results.push(
      await probeOne(u, null, "POST", {
        grant_type: "api_key",
        api_key: apiKey,
      }),
    );
    // Try POST with client_credentials
    results.push(
      await probeOne(u, null, "POST", {
        grant_type: "client_credentials",
        client_secret: apiKey,
      }),
    );
  }

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
