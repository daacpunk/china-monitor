# CEIC Python bridge

A **local** collector that pulls CEIC series with your CEIC *website* credentials
and pushes them into China Monitor. It runs on your machine, never on Railway.

> **Status: unverified against a live account.** The probe and collector were
> written against CEIC's published Python examples and defensive runtime
> introspection, but they have **not** been executed against a real CEIC login —
> no credentials were available during the build. Run `probe.py` first; it will
> tell you honestly whether your subscription supports this path. The
> **CDMNext Excel/CSV import path in China Monitor works today and needs none of
> this.**

---

## Why this exists

China Monitor's CEIC API key has no data entitlement — `/series/{id}/data`
returns an explicit 403 deny. The subscription you actually hold is a
**website / CDMNext** subscription. That gives two viable routes:

| Route | What it needs | Where it runs |
|---|---|---|
| **CDM import** (works today) | A CDMNext Excel/CSV export, up to 3,000 series at a time | Imports → CEIC tab in the browser |
| **Python bridge** (this directory) | CEIC's Python client + your login | Your laptop / a scheduled local job |
| REST API (retained, dormant) | An entitled API key you do not currently have | Server-side, auto-enabled if the key is ever upgraded |

Both non-API routes land in the same tables and produce identical downstream
behaviour: catalog rows, revision-aware vintages, and refreshed current values
that flow into the dashboards, strategy report, and PPTX deck through
`fetchSeries`.

---

## Install

CEIC's Python client is **not on public PyPI**. It is served from CEIC's own
package index:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install --extra-index-url https://downloads.ceicdata.com/python ceic_api_client
```

If that index refuses your account, CEIC has not enabled Python access for your
subscription. Ask CEIC support to enable it, and use the CDM import path
meanwhile.

## Configure

```bash
cp .env.example .env
$EDITOR .env          # CEIC_LOGIN, CEIC_PASSWORD, (optional) CEIC_APPLICATION
```

Credentials are read from the environment **only**. They are never logged,
never written to any output file, never sent to China Monitor, and there is no
password field anywhere in the China Monitor web UI. `.gitignore` in this
directory already excludes `.env`, `state.json`, `manifest.json`, and `out/`.

## 1. Probe

```bash
python3 probe.py
python3 probe.py --series <A_SERIES_ID_YOU_CAN_SEE_IN_CDMNEXT>
```

Prints one redacted JSON object: package version, which entry points exist
(`pyceic.Ceic` facade vs generated `SessionsApi`/`SeriesApi`), which login
signature worked, session type (token redacted to a type + length), search
result count, one truncated series id/name, timepoint retrieval result, and
whether vintage / release / async surfaces appear on the installed build.

Exit codes: `0` fully working · `2` SDK not installed · `3` credentials missing
· `4` login failed · `5` login ok but data blocked · `6` login ok but API
unusable.

The output is safe to paste into a support ticket.

## 2. Collect

```bash
cp manifest.sample.json manifest.json
$EDITOR manifest.json         # replace every <PLACEHOLDER> with a real CEIC series ID
python3 collector.py          # dry run → writes out/ceic_<stamp>.{json,csv}
python3 collector.py --post   # also upload to China Monitor
```

`manifest.sample.json` ships **placeholder IDs only** — no fabricated CEIC IDs.
It targets the six highest-value indicators: total social financing, DR007,
SHIBOR, property sales, retail sales, industrial profits.

The collector keeps `state.json` (last successful observation date per series)
and only requests periods after it. Delete `state.json` to force a full
backfill, or pass `--since 2015-01-01`.

If the HTTP upload is inconvenient, the emitted `out/ceic_<stamp>.csv` is a
long-format export you can drop straight into **Imports → CEIC** in the browser.

## 3. Upload token

`--post` calls `POST /api/imports/ceic-bridge`, authenticated by a shared
secret that is **completely separate from your CEIC password**:

```bash
# generate once
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Set the same value in two places:

* Railway → your China Monitor service → Variables → `CEIC_IMPORT_TOKEN`
* this directory's `.env` → `CEIC_IMPORT_TOKEN` (plus `CHINA_MONITOR_URL`)

The endpoint compares tokens in constant time, enforces row/series/body limits,
validates the payload schema, and is idempotent on a SHA-256 of the normalised
payload. With no `CEIC_IMPORT_TOKEN` configured server-side the route answers
`503 bridge_disabled` — it is never an open upload endpoint.

## 4. Schedule (optional)

```cron
# 07:15 every weekday, local time
15 7 * * 1-5 cd /path/to/ceic-python-bridge && ./.venv/bin/python collector.py --post >> collector.log 2>&1
```

`collector.log` contains only scrubbed messages; secrets are redacted before
anything is printed.

---

## Known uncertainty

CEIC does not publish a stable, versioned reference for the Python client's
class and method signatures, and the package bundles both a high-level facade
and a generated OpenAPI client whose names differ between builds. Rather than
hardcode one shape, `probe.py` and `collector.py` enumerate the documented
candidates (`Ceic.login`, `SessionsApi.login/post_login/create_session`,
`Ceic.series`, `SeriesApi.get_series_time_points/get_series`, …), call each with
only the keyword arguments its signature accepts, and report exactly which one
worked or exactly how each failed. Nothing is faked when none of them work — the
collector exits non-zero with the full list of attempts.

Specifically unverified until you run it with a live account:

* whether your subscription grants Python/API access at all;
* whether `CEIC_APPLICATION` is required and what value it should take;
* the exact login signature and base URL used by your installed build;
* whether vintages/releases endpoints are exposed to your account.

## Sources

* Install command and `from ceic_api_client.pyceic import Ceic` / `Ceic.login(user, pasw)` usage:
  [CEIC Python walkthrough — "How to track Traditional Economic Indicators with real-time data"](https://medium.com/@necheverry_20468/how-to-track-traditional-economic-indicators-with-real-time-data-c3193d6528e6)
  and [CEIC nowcasting walkthrough](https://medium.com/@necheverry_20468/nowcasting-u-s-inflation-using-high-frequency-data-98905dc58c1d)
* Timepoint container shape (`time_points`, `tp._date`, `tp.value`, `metadata.frequency.id`):
  same walkthroughs above.
* `GET /series/{id}` default of 3,650 timepoints, session expiry, and the list of
  official SDKs (Python, JS, R, PHP):
  [CEIC API v2 release notes](https://downloads.ceicdata.com/api/documentation/api-release-notes.html)
* SDK availability across Python/PHP/JavaScript:
  [CEIC Custom Solutions (PDF)](https://cdn2.hubspot.net/hubfs/4289410/CEIC%20Custom%20Solutions.pdf)
* CDMNext export limit of 3,000 series per export and CEIC API/data-feed product scope:
  [CEIC APIs and Feeds product page](https://info.ceicdata.com/api-and-data-feed-solution)
