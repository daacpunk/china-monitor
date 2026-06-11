# Hosting the AKShare sidecar from a China region

## Why move it

The sidecar makes **outbound** calls to EastMoney / Sina / jin10. From Railway's
US egress IP, some of those endpoints (the EastMoney *push2* quote endpoints used
for A-share PE/PB/market-cap valuation) return empty or get blocked. Macro series
(`cjsj`) and index OHLCV (`push2his`) work fine, but **valuations don't**.

Running the sidecar from a **Hong Kong** or **mainland China** host fixes this,
because those data sources respond normally to China-region IPs.

> **You do NOT need an ICP filing.** ICP is only required to *serve* a website or
> app to users inside mainland China. Your sidecar only *consumes* data outbound —
> it serves JSON privately to your Railway app. No ICP, no 备案.

You are in Hong Kong, so a **Hong Kong VPS is the simplest, lowest-friction option**
and will very likely restore valuations. A mainland VPS gives the most complete
data access but adds account/billing friction. Both work with the steps below.

---

## What you're deploying

The sidecar is already fully containerized and host-agnostic:

```
akshare-sidecar/
  Dockerfile          # python:3.11-slim, installs requirements, runs main.py
  main.py             # FastAPI app, reads $PORT and $AKSHARE_TOKEN
  requirements.txt
```

It needs two env vars:

| Env var            | Value                                                        |
|--------------------|--------------------------------------------------------------|
| `AKSHARE_TOKEN`    | the shared secret (same value the main app sends)            |
| `PORT`             | the port to listen on (e.g. `8000`)                          |
| `AKSHARE_CACHE_TTL`| optional, seconds; default `86400` (24h)                     |

The main app finds it via two env vars **on the main Railway service**:

| Env var               | Value                                            |
|-----------------------|--------------------------------------------------|
| `AKSHARE_SIDECAR_URL` | the public URL of your new sidecar (https://...) |
| `AKSHARE_TOKEN`       | must match the sidecar's `AKSHARE_TOKEN`         |

So the migration is: **stand up the sidecar somewhere in HK/CN → point
`AKSHARE_SIDECAR_URL` at it → keep `AKSHARE_TOKEN` identical on both sides.**

---

## Option A — Hong Kong VPS (recommended for you)

Any HK VPS works: **Alibaba Cloud (HK region)**, **Tencent Cloud (HK)**, Vultr HK,
DigitalOcean (no HK, but Singapore is close), or a local HK provider. Steps assume
a fresh Ubuntu 22.04/24.04 box with a public IP.

### 1. Create the VPS
- Region: **Hong Kong**. Smallest tier is plenty (1 vCPU / 1–2 GB RAM).
- Open inbound TCP on your chosen port (e.g. `8000`) **only to Railway**, or put it
  behind a reverse proxy with TLS (recommended — see step 5).

### 2. Install Docker
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # then re-login
```

### 3. Get the sidecar code onto the box
```bash
git clone https://github.com/daacpunk/china-monitor.git
cd china-monitor/akshare-sidecar
```
(Or `scp` just the `akshare-sidecar/` folder up — it's self-contained.)

### 4. Build and run (one command via docker-compose)
```bash
cp .env.example .env
nano .env                 # set AKSHARE_TOKEN=<YOUR_SHARED_SECRET>
docker compose up -d --build
```
That's it. The container auto-restarts on reboot/crash and has a built-in
`/health` healthcheck. Check status with `docker compose ps` and logs with
`docker compose logs -f`.

<details>
<summary>Alternative: plain <code>docker run</code> (no compose)</summary>

```bash
docker build -t akshare-sidecar .
docker run -d --name akshare-sidecar \
  --restart unless-stopped \
  -p 8000:8000 \
  -e AKSHARE_TOKEN='<YOUR_SHARED_SECRET>' \
  -e PORT=8000 \
  akshare-sidecar
```
</details>

Verify locally on the box:
```bash
curl -s localhost:8000/health
curl -s -H "X-AKShare-Token: <YOUR_SHARED_SECRET>" \
  "localhost:8000/financials/valuation/600519"   # should now return PE/PB/mktcap
```

### 5. Put TLS in front (strongly recommended)
Railway calls the sidecar over the public internet, so use HTTPS + a domain.
Easiest is Caddy (auto-Let's-Encrypt):

```bash
# /etc/caddy/Caddyfile
sidecar.yourdomain.com {
    reverse_proxy localhost:8000
}
```
```bash
sudo apt install -y caddy
sudo systemctl restart caddy
```
Point an A record `sidecar.yourdomain.com` → your VPS IP. Caddy fetches a cert
automatically. Now the sidecar is reachable at `https://sidecar.yourdomain.com`.

> If you'd rather skip a domain, you can use the raw `http://<VPS_IP>:8000`, but
> then traffic (including the token header) is unencrypted. Prefer TLS.

### 6. Lock it down
- Firewall: allow port 8000 (or 443 if using Caddy) only. The `AKSHARE_TOKEN`
  header already gates every data endpoint, but also restrict by source IP if your
  provider supports it.
- Keep `AKSHARE_TOKEN` long and random (the one already set works).

### 7. Repoint the main app
In **Railway → main `china-monitor` service → Variables**, set:
```
AKSHARE_SIDECAR_URL = https://sidecar.yourdomain.com
AKSHARE_TOKEN       = <YOUR_SHARED_SECRET>   # same as the VPS
```
Redeploy/restart the main service. Done — valuations should populate.

### 8. Confirm end-to-end
```bash
curl -s "https://china-monitor-production.up.railway.app/api/akshare/health"
curl -s "https://china-monitor-production.up.railway.app/api/equity/valuation/600519"
```
The valuation call should now return real `pe_ttm` / `pb` / `market_cap`.

---

## Option B — Mainland China VPS (most complete data access)

Same Docker steps as Option A, but on **Alibaba Cloud ECS** or **Tencent Cloud CVM**
in a mainland region (Beijing / Shanghai / Shenzhen).

Extra considerations:
- You can sign up for Alibaba/Tencent Cloud **international** accounts from Hong Kong;
  mainland regions are available without a Chinese business entity for compute
  (ICP only bites if you serve a *website* into China, which you aren't).
- The box sits behind the Great Firewall, so outbound to global services can be
  slower; but its access to EastMoney/Sina is the best of any option.
- Same `AKSHARE_SIDECAR_URL` repoint as Option A.

Use mainland only if you find some endpoints still flaky from HK; otherwise HK is
the better cost/effort tradeoff for you.

---

## Option C — Keep Railway, proxy only the blocked calls

If you'd rather not move the whole sidecar, run a tiny HTTP forward-proxy on an
HK/CN VPS and have the sidecar route just the EastMoney quote calls through it
(set `HTTP_PROXY`/`HTTPS_PROXY` for the relevant requests). This is more moving
parts and harder to reason about than Option A; only worth it if you want to keep
the sidecar on Railway for ops consistency.

---

## Rollback

If anything goes wrong, set `AKSHARE_SIDECAR_URL` back to the Railway-internal URL
(`http://akshare-sidecar.railway.internal:8000`) and restart the main service. The
old Railway sidecar keeps working for everything except A-share valuations.

## Cost

A 1 vCPU / 1–2 GB HK VPS runs roughly US$5–10/month (Vultr/Alibaba/Tencent).
The sidecar is light — it caches 24h and only fetches on demand.
