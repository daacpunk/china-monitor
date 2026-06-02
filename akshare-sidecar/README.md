# china-monitor AKShare sidecar

FastAPI service that wraps [AKShare](https://github.com/akfamily/akshare) for the china-monitor dashboard. Runs as a separate Railway service alongside the main Express app.

## Why a sidecar?

AKShare is Python-only and has heavy native deps (pandas, numpy, scipy). Bundling it into the Node.js main service would bloat the image and complicate deploys. A separate service keeps Python deps isolated and lets us scale/restart it independently.

## Endpoints

All endpoints (except `/health`) require header `X-AKShare-Token: <AKSHARE_TOKEN>`.

| Path | Description | Cache TTL |
|---|---|---|
| `GET /health` | Liveness + akshare version + cache stats | — |
| `GET /ashare/historical?symbol=600519&start=2020-01-01&end=2026-06-01&adjust=qfq` | A-share daily OHLCV | 24h |
| `GET /hk/historical?symbol=00700&start=2020-01-01&adjust=qfq` | HK Connect daily OHLCV | 24h |
| `GET /sector/flows?indicator=今日` | Industry sector money-flow snapshot (`今日` / `5日` / `10日`) | 24h |
| `GET /financials/income?symbol=600519` | Annual income statement (Sina) | 24h |

## Local dev

```bash
cd akshare-sidecar
pip install -r requirements.txt
export AKSHARE_TOKEN=dev-token-local
python main.py
# → http://localhost:8000/docs
```

```bash
curl -H "X-AKShare-Token: dev-token-local" \
     "http://localhost:8000/ashare/historical?symbol=600519&start=2024-01-01"
```

## Railway deployment

Add as a second service in the existing `china-monitor` Railway project:

1. Railway dashboard → china-monitor project → New Service → from same repo
2. Root directory: `/akshare-sidecar`
3. Builder: Dockerfile (auto-detected via `railway.toml`)
4. Env vars:
   - `AKSHARE_TOKEN` — strong random string (also set on main service)
   - `AKSHARE_CACHE_TTL` (optional, default `86400` = 24h)
5. Generate a domain or expose internally
6. Main service env: set `AKSHARE_SIDECAR_URL=https://<sidecar>.railway.app` + matching `AKSHARE_TOKEN`

## Main service integration

The main app has a thin client `server/clients/akshare.ts` that calls this service. See its source for the exact contract.
