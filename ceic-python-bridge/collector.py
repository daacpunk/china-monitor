#!/usr/bin/env python3
"""
CEIC → China Monitor local collector.

Runs on YOUR machine (never on Railway). Reads an allowlist manifest of CEIC
series, logs in with your CEIC website credentials, pulls only the periods
since the last successful observation, writes a normalised JSON/CSV snapshot,
and optionally POSTs the payload to China Monitor's token-protected bridge
endpoint.

    python3 collector.py                     # dry run, writes ./out/ only
    python3 collector.py --post              # also upload to China Monitor
    python3 collector.py --since 2024-01-01  # override incremental start
    python3 collector.py --manifest my.json

DESIGN NOTES
------------
* Credentials come from the environment only (CEIC_LOGIN / CEIC_PASSWORD /
  CEIC_APPLICATION) and are never logged or written to any output file.
* The upload uses CEIC_IMPORT_TOKEN, a SHARED SECRET that is completely
  separate from your CEIC password. Only the token ever leaves this machine
  toward China Monitor.
* Incremental state lives in ./state.json (last successful observation date per
  series). Delete it to force a full backfill.
* The SDK surface is accessed through the same defensive introspection as
  probe.py, because CEIC's generated client differs between builds. If nothing
  works, the collector FAILS LOUDLY with the exact attempts it made — it never
  invents data.
"""

from __future__ import annotations

import argparse
import csv
import inspect
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, datetime
from typing import Any, Callable

try:  # pragma: no cover - convenience only
    from dotenv import load_dotenv  # type: ignore

    load_dotenv()
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MANIFEST = os.path.join(HERE, "manifest.json")
SAMPLE_MANIFEST = os.path.join(HERE, "manifest.sample.json")
STATE_PATH = os.path.join(HERE, "state.json")
OUT_DIR = os.path.join(HERE, "out")


# ── Secret hygiene ──────────────────────────────────────────────────────────

def scrub(msg: str) -> str:
    for var in ("CEIC_LOGIN", "CEIC_PASSWORD", "CEIC_APPLICATION", "CEIC_IMPORT_TOKEN"):
        secret = os.environ.get(var)
        if secret:
            msg = msg.replace(secret, "<redacted>")
    return msg


def log(msg: str) -> None:
    print(f"[collector] {scrub(msg)}", file=sys.stderr)


def die(msg: str, code: int = 1) -> "NoReturn":  # type: ignore[valid-type]
    log(f"FATAL: {msg}")
    sys.exit(code)


# ── SDK access (same introspection contract as probe.py) ────────────────────

def call_with_supported_kwargs(fn: Callable, *args: Any, **kwargs: Any) -> Any:
    try:
        sig = inspect.signature(fn)
        if not any(p.kind is p.VAR_KEYWORD for p in sig.parameters.values()):
            kwargs = {k: v for k, v in kwargs.items() if k in set(sig.parameters)}
    except (TypeError, ValueError):
        pass
    return fn(*args, **kwargs)


class CeicClient:
    """Thin adapter over whichever CEIC Python entry point is installed."""

    def __init__(self) -> None:
        try:
            import ceic_api_client  # noqa: F401
        except Exception as exc:
            die(
                "ceic_api_client is not installed. Install the vendor client:\n"
                "  pip install --extra-index-url https://downloads.ceicdata.com/python ceic_api_client\n"
                "It is not on public PyPI. If that index refuses your account, CEIC has not "
                "enabled Python access for your subscription — use the CDMNext Excel/CSV "
                "import path in China Monitor instead.\n"
                f"import error: {scrub(str(exc))}",
                2,
            )
        self.facade = None
        self.series_api = None
        try:
            from ceic_api_client.pyceic import Ceic  # type: ignore

            self.facade = Ceic
        except Exception:
            pass
        try:
            import importlib

            api_mod = importlib.import_module("ceic_api_client.api")
            cls = getattr(api_mod, "SeriesApi", None)
            if cls is not None:
                self.series_api = cls()
        except Exception:
            pass
        if self.facade is None and self.series_api is None:
            die("ceic_api_client imported but exposes neither pyceic.Ceic nor api.SeriesApi.", 2)

    def login(self, login: str, password: str, application: str | None) -> None:
        attempts: list[str] = []
        if self.facade is not None:
            for label, kwargs in (
                ("Ceic.login(login,password,application)", {"application": application} if application else None),
                ("Ceic.login(login,password)", {}),
            ):
                if kwargs is None:
                    continue
                try:
                    call_with_supported_kwargs(self.facade.login, login, password, **kwargs)
                    log(f"login ok via {label}")
                    return
                except Exception as exc:
                    attempts.append(f"{label} -> {type(exc).__name__}: {scrub(str(exc))[:200]}")
        try:
            import importlib

            api_mod = importlib.import_module("ceic_api_client.api")
            sessions_cls = getattr(api_mod, "SessionsApi", None)
            if sessions_cls is not None:
                api = sessions_cls()
                for name in ("login", "post_login", "create_session"):
                    fn = getattr(api, name, None)
                    if fn is None:
                        continue
                    try:
                        call_with_supported_kwargs(fn, login, password, application=application)
                        log(f"login ok via SessionsApi.{name}")
                        return
                    except Exception as exc:
                        attempts.append(f"SessionsApi.{name} -> {type(exc).__name__}: {scrub(str(exc))[:200]}")
        except Exception as exc:
            attempts.append(f"SessionsApi import -> {scrub(str(exc))[:200]}")
        die("CEIC login failed. Attempts:\n  " + "\n  ".join(attempts) + "\nRun probe.py for a full diagnostic.", 4)

    def timepoints(self, series_id: str, start_date: str | None, count: int) -> list[dict[str, Any]]:
        """Return [{'date': 'YYYY-MM-DD', 'value': float|None}] or raise."""
        attempts: list[str] = []
        candidates: list[tuple[str, Callable]] = []
        if self.facade is not None:
            for name in ("series", "get_series", "series_data", "get_series_time_points"):
                fn = getattr(self.facade, name, None)
                if callable(fn):
                    candidates.append((f"Ceic.{name}", fn))
        if self.series_api is not None:
            for name in ("get_series_time_points", "get_series", "series_time_points"):
                fn = getattr(self.series_api, name, None)
                if callable(fn):
                    candidates.append((f"SeriesApi.{name}", fn))
        for label, fn in candidates:
            try:
                res = call_with_supported_kwargs(
                    fn,
                    series_id,
                    id=series_id,
                    series_id=series_id,
                    start_date=start_date,
                    startDate=start_date,
                    count=count,
                    limit=count,
                )
                pts = extract_points(res)
                if pts:
                    return pts
                attempts.append(f"{label} -> returned no timepoints")
            except Exception as exc:
                attempts.append(f"{label} -> {type(exc).__name__}: {scrub(str(exc))[:200]}")
        raise RuntimeError("no timepoint method succeeded: " + " | ".join(attempts[:4]))


def extract_points(res: Any) -> list[dict[str, Any]]:
    """Normalise every documented CEIC timepoint container into plain dicts."""
    container: Any = None
    for attr in ("time_points", "timePoints"):
        container = getattr(res, attr, None)
        if container:
            break
    if container is None:
        data = getattr(res, "data", None)
        if data is None and isinstance(res, dict):
            data = res.get("data")
        if isinstance(data, list) and data:
            first = data[0]
            container = (
                getattr(first, "time_points", None)
                or getattr(first, "timePoints", None)
                or (first.get("timePoints") or first.get("time_points") if isinstance(first, dict) else None)
            )
        elif data is not None:
            container = getattr(data, "time_points", None) or getattr(data, "timePoints", None)
    if not container:
        return []
    out: list[dict[str, Any]] = []
    for tp in container:
        d = getattr(tp, "_date", None) or getattr(tp, "date", None)
        v = getattr(tp, "value", None)
        if isinstance(tp, dict):
            d = d or tp.get("date") or tp.get("_date")
            v = tp.get("value") if v is None else v
        if d is None:
            continue
        try:
            val = None if v is None or v == "" else float(v)
        except (TypeError, ValueError):
            val = None
        out.append({"date": str(d)[:10], "value": val})
    out.sort(key=lambda p: p["date"])
    return out


# ── Manifest / state ────────────────────────────────────────────────────────

def load_manifest(path: str) -> list[dict[str, Any]]:
    if not os.path.exists(path):
        die(
            f"manifest not found: {path}\n"
            f"Copy the sample and replace the placeholder IDs with real CEIC series IDs:\n"
            f"  cp {os.path.relpath(SAMPLE_MANIFEST, HERE)} {os.path.relpath(path, HERE)}",
            3,
        )
    with open(path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    series = doc.get("series") if isinstance(doc, dict) else doc
    if not isinstance(series, list) or not series:
        die("manifest has no `series` array")
    cleaned: list[dict[str, Any]] = []
    for i, s in enumerate(series):
        sid = str(s.get("seriesId") or "").strip()
        if not sid:
            die(f"manifest entry {i} has no seriesId")
        if sid.startswith("<") or "PLACEHOLDER" in sid.upper():
            log(f"skipping placeholder entry {sid!r} — replace it with a real CEIC series ID")
            continue
        cleaned.append(s)
    if not cleaned:
        die(
            "every manifest entry is still a placeholder. Open CDMNext, copy the real CEIC "
            "series IDs for the indicators you want, and put them in the manifest."
        )
    return cleaned


def load_state() -> dict[str, str]:
    if not os.path.exists(STATE_PATH):
        return {}
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def save_state(state: dict[str, str]) -> None:
    with open(STATE_PATH, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)


# ── Upload ──────────────────────────────────────────────────────────────────

def post_to_china_monitor(base_url: str, token: str, payload: dict[str, Any]) -> dict[str, Any]:
    url = base_url.rstrip("/") + "/api/imports/ceic-bridge"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            # The ONLY secret sent to China Monitor. Never the CEIC password.
            "x-ceic-import-token": token,
            "User-Agent": "ceic-python-bridge/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:600]
        if exc.code == 401:
            die("bridge rejected the token (401). CEIC_IMPORT_TOKEN must match the value set on Railway.", 7)
        if exc.code == 503:
            die("bridge is disabled (503): CEIC_IMPORT_TOKEN is not configured on the server.", 7)
        die(f"upload failed HTTP {exc.code}: {detail}", 7)
    except urllib.error.URLError as exc:
        die(f"upload failed (network): {scrub(str(exc.reason))}", 7)


# ── Main ────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="Collect CEIC series and push them to China Monitor")
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
    ap.add_argument("--since", help="Force a start date (YYYY-MM-DD) instead of incremental state")
    ap.add_argument("--count", type=int, default=3650, help="Max timepoints per series (CEIC default is 3650)")
    ap.add_argument("--post", action="store_true", help="Upload to China Monitor after collecting")
    ap.add_argument("--out", default=OUT_DIR)
    args = ap.parse_args()

    login = os.environ.get("CEIC_LOGIN")
    password = os.environ.get("CEIC_PASSWORD")
    application = os.environ.get("CEIC_APPLICATION") or None
    if not login or not password:
        die("CEIC_LOGIN and CEIC_PASSWORD must be set in the environment (see .env.example).", 3)

    manifest = load_manifest(args.manifest)
    state = load_state()

    client = CeicClient()
    client.login(login, password, application)

    vintage = date.today().isoformat()
    collected: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []

    for entry in manifest:
        sid = str(entry["seriesId"]).strip()
        since = args.since or state.get(sid)
        try:
            pts = client.timepoints(sid, since, args.count)
        except Exception as exc:
            log(f"{sid}: FAILED — {scrub(str(exc))[:300]}")
            failures.append({"seriesId": sid, "error": scrub(str(exc))[:300]})
            continue
        if since:
            pts = [p for p in pts if p["date"] >= since]
        if not pts:
            log(f"{sid}: no new observations since {since or 'inception'}")
            continue
        collected.append(
            {
                "seriesId": sid,
                "label": entry.get("label") or sid,
                "mnemonic": entry.get("mnemonic"),
                "unit": entry.get("unit"),
                "frequency": entry.get("frequency"),
                "geo": entry.get("geo"),
                "source": entry.get("source"),
                "logicalId": entry.get("logicalId"),
                "transform": entry.get("transform"),
                "points": pts,
            }
        )
        state[sid] = pts[-1]["date"]
        log(f"{sid}: {len(pts)} points, through {pts[-1]['date']}")

    if not collected:
        log("nothing collected — state unchanged, nothing uploaded")
        if failures:
            log(f"{len(failures)} series failed; run probe.py for a full diagnostic")
            return 5
        return 0

    os.makedirs(args.out, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    payload = {"runId": f"{stamp}", "vintageDate": vintage, "series": collected}

    json_path = os.path.join(args.out, f"ceic_{stamp}.json")
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    log(f"wrote {json_path}")

    # Long-format CSV: directly re-importable through the Imports → CEIC tab
    # if the HTTP upload is unavailable (air-gapped laptop, VPN, etc.).
    csv_path = os.path.join(args.out, f"ceic_{stamp}.csv")
    with open(csv_path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["series_id", "series_label", "date", "value", "unit", "frequency", "source", "country"])
        for s in collected:
            for p in s["points"]:
                w.writerow([
                    s["seriesId"], s["label"], p["date"],
                    "" if p["value"] is None else p["value"],
                    s.get("unit") or "", s.get("frequency") or "",
                    s.get("source") or "", s.get("geo") or "",
                ])
    log(f"wrote {csv_path}")

    if args.post:
        base = os.environ.get("CHINA_MONITOR_URL")
        token = os.environ.get("CEIC_IMPORT_TOKEN")
        if not base:
            die("CHINA_MONITOR_URL is not set (e.g. https://your-app.up.railway.app).", 3)
        if not token:
            die("CEIC_IMPORT_TOKEN is not set — it must match the value configured on Railway.", 3)
        res = post_to_china_monitor(base, token, payload)
        commit = res.get("commit", {})
        log(
            "upload ok: "
            f"duplicate={commit.get('duplicate')} series={commit.get('seriesCount')} "
            f"vintageRows={commit.get('vintageRows')} currentRows={commit.get('currentRows')} "
            f"mapped={len(commit.get('mappedSeries') or [])}"
        )

    save_state(state)
    log(f"state saved for {len(state)} series")
    if failures:
        log(f"{len(failures)} series failed; see above")
        return 5
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
