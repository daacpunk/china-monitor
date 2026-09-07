#!/usr/bin/env python3
"""
CEIC Python SDK login probe.

WHAT THIS IS
------------
A read-only diagnostic. It answers one question honestly: *can this machine,
with these CEIC website credentials, log in and retrieve a subscribed series
through the CEIC Python SDK?* It does NOT pretend to work without a live
account, and it does not write anything to China Monitor.

Run it on YOUR machine (never on Railway). It prints a single redacted JSON
object to stdout so the output can be pasted into an issue safely.

WHY IT IS DEFENSIVE
-------------------
CEIC ships the Python client from a private index, not PyPI, and the package
bundles both a high-level facade (`ceic_api_client.pyceic.Ceic`) and a
generated OpenAPI client (`ceic_api_client.api.*`). Exact constructor and
method signatures differ between builds, and CEIC's own public docs do not
pin them. So every call below is made through runtime introspection: we look
at what actually exists on the installed package, try the documented shapes in
order, and report precisely which one worked (or precisely how each failed).

Documented reference points used to seed the attempts:
  - install:  pip install --extra-index-url https://downloads.ceicdata.com/python ceic_api_client
  - facade:   from ceic_api_client.pyceic import Ceic ; Ceic.login(user, password)
  - count:    GET /series/{id} defaults to 3650 timepoints; pass sys.maxsize for all
  (see README.md for the source links)

USAGE
-----
    cp .env.example .env      # then fill in your CEIC login
    python3 probe.py          # or: python3 probe.py --series <CEIC_SERIES_ID>

SECURITY
--------
Credentials are read from the environment ONLY (CEIC_LOGIN, CEIC_PASSWORD,
CEIC_APPLICATION). They are never printed, never logged, never written to
disk, and never sent anywhere except CEIC. Session tokens are redacted to a
type name plus a length. Series names in the output are truncated.
"""

from __future__ import annotations

import argparse
import inspect
import json
import os
import sys
import traceback
from typing import Any, Callable

# ── Optional .env loading (python-dotenv is not required) ────────────────────
try:  # pragma: no cover - convenience only
    from dotenv import load_dotenv  # type: ignore

    load_dotenv()
except Exception:
    pass


REDACTED = "<redacted>"


def redact_secret(value: str | None) -> str:
    """Never echo a credential. Report only that it is present and how long."""
    if not value:
        return "<missing>"
    return f"<set:{len(value)}chars>"


def redact_token(value: Any) -> str:
    if value is None:
        return "<none>"
    s = str(value)
    return f"<{type(value).__name__}:{len(s)}chars>"


def truncate(value: Any, n: int = 60) -> str | None:
    if value is None:
        return None
    s = str(value)
    return s if len(s) <= n else s[: n - 1] + "\u2026"


def short_error(exc: BaseException) -> str:
    """One-line error text with anything credential-shaped stripped out."""
    msg = f"{type(exc).__name__}: {exc}"
    for var in ("CEIC_LOGIN", "CEIC_PASSWORD", "CEIC_APPLICATION"):
        secret = os.environ.get(var)
        if secret:
            msg = msg.replace(secret, REDACTED)
    return msg[:400]


def public_methods(obj: Any, limit: int = 60) -> list[str]:
    out = []
    for name in dir(obj):
        if name.startswith("_"):
            continue
        try:
            attr = getattr(obj, name)
        except Exception:
            continue
        if callable(attr):
            out.append(name)
    return sorted(out)[:limit]


def call_with_supported_kwargs(fn: Callable, *args: Any, **kwargs: Any) -> Any:
    """
    Call `fn` passing only the kwargs its signature actually accepts.

    Generated SDK methods differ across builds (`count` vs `limit`,
    `subscribed_only` present or absent). Filtering by signature avoids a
    TypeError avalanche and keeps the probe useful on any build.
    """
    try:
        sig = inspect.signature(fn)
        accepted = set(sig.parameters)
        has_var_kw = any(p.kind is p.VAR_KEYWORD for p in sig.parameters.values())
        if not has_var_kw:
            kwargs = {k: v for k, v in kwargs.items() if k in accepted}
    except (TypeError, ValueError):
        pass
    return fn(*args, **kwargs)


def main() -> int:
    ap = argparse.ArgumentParser(description="CEIC Python SDK login probe (redacted output)")
    ap.add_argument("--series", help="Optional known CEIC series ID to test metadata/data retrieval")
    ap.add_argument("--keyword", default="China", help="Search keyword for the smallest possible search")
    ap.add_argument("--limit", type=int, default=1, help="Search result limit (keep tiny)")
    args = ap.parse_args()

    report: dict[str, Any] = {
        "probe": "ceic-python-bridge/probe.py",
        "python": sys.version.split()[0],
        "credentials": {
            "CEIC_LOGIN": redact_secret(os.environ.get("CEIC_LOGIN")),
            "CEIC_PASSWORD": redact_secret(os.environ.get("CEIC_PASSWORD")),
            "CEIC_APPLICATION": redact_secret(os.environ.get("CEIC_APPLICATION")),
        },
        "package": {"importable": False, "name": "ceic_api_client", "version": None, "path": None},
        "facade": {"available": False},
        "generated_client": {"available": False},
        "login": {"ok": False, "strategy": None, "error": None},
        "session": {"type": None, "token": None},
        "search": {"ok": False, "method": None, "count": None, "sample": None, "error": None},
        "metadata": {"ok": False, "method": None, "sample": None, "error": None},
        "timepoints": {"ok": False, "method": None, "count": None, "firstDate": None, "lastDate": None, "error": None},
        "capabilities": {"vintages": None, "releases": None, "async": None},
        "verdict": None,
        "nextSteps": [],
    }

    login = os.environ.get("CEIC_LOGIN")
    password = os.environ.get("CEIC_PASSWORD")
    application = os.environ.get("CEIC_APPLICATION") or "CEIC_Python"

    # ── 1. Package import ────────────────────────────────────────────────────
    try:
        import ceic_api_client  # type: ignore

        report["package"]["importable"] = True
        report["package"]["version"] = getattr(ceic_api_client, "__version__", None)
        report["package"]["path"] = truncate(getattr(ceic_api_client, "__file__", None), 160)
    except Exception as exc:
        report["package"]["error"] = short_error(exc)
        report["verdict"] = "sdk_not_installed"
        report["nextSteps"] = [
            "Install the vendor-provided client from CEIC's private index:",
            "If you have the tarball: pip install /path/to/ceic_api_client-2.11.5.8.tar.gz",
            "Else: pip install --extra-index-url https://downloads.ceicdata.com/python ceic_api_client",
            "It is NOT on public PyPI and must not be committed to china-monitor.",
            "Until then use the CDMNext Excel/CSV path: Imports \u2192 CEIC tab in China Monitor.",
        ]
        print(json.dumps(report, indent=2))
        return 2

    # ── 2. Discover the entry points this build exposes ──────────────────────
    Ceic = None
    try:
        from ceic_api_client.pyceic import Ceic as _Ceic  # type: ignore

        Ceic = _Ceic
        report["facade"] = {
            "available": True,
            "class": "ceic_api_client.pyceic.Ceic",
            "methods": public_methods(Ceic),
            "login_signature": None,
        }
        try:
            report["facade"]["login_signature"] = str(inspect.signature(Ceic.login))
        except Exception:
            pass
    except Exception as exc:
        report["facade"] = {"available": False, "error": short_error(exc)}

    sessions_api_cls = None
    series_api_cls = None
    try:
        import importlib

        api_mod = None
        for mod_name in ("ceic_api_client.apis", "ceic_api_client.api"):
            try:
                api_mod = importlib.import_module(mod_name)
                break
            except Exception:
                continue
        if api_mod is None:
            raise ImportError("ceic_api_client.apis / ceic_api_client.api not found")
        sessions_api_cls = getattr(api_mod, "SessionsApi", None)
        series_api_cls = getattr(api_mod, "SeriesApi", None)
        report["generated_client"] = {
            "available": bool(sessions_api_cls or series_api_cls),
            "SessionsApi": bool(sessions_api_cls),
            "SeriesApi": bool(series_api_cls),
            "sessions_methods": public_methods(sessions_api_cls) if sessions_api_cls else [],
            "series_methods": public_methods(series_api_cls) if series_api_cls else [],
        }
    except Exception as exc:
        report["generated_client"] = {"available": False, "error": short_error(exc)}

    if not login or not password:
        report["verdict"] = "credentials_missing"
        report["nextSteps"] = [
            "Set CEIC_LOGIN and CEIC_PASSWORD in your local environment or .env, then re-run.",
            "Do NOT put credentials in China Monitor, Railway, or any web form \u2014 this probe "
            "and collector.py are the only places they belong, and only on your own machine.",
        ]
        print(json.dumps(report, indent=2))
        return 3

    # ── 3. Login ─────────────────────────────────────────────────────────────
    session_obj = None
    login_errors: list[str] = []

    # Strategy A: documented facade — Ceic.login(user, password[, application])
    if Ceic is not None:
        for strategy, kwargs in (
            ("facade:login(login,password,application)", {"application": application} if application else None),
            ("facade:login(login,password)", {}),
        ):
            if kwargs is None:
                continue
            try:
                session_obj = call_with_supported_kwargs(Ceic.login, login, password, **kwargs)
                report["login"] = {"ok": True, "strategy": strategy, "error": None}
                break
            except Exception as exc:
                login_errors.append(f"{strategy} -> {short_error(exc)}")

    # Strategy B: generated SessionsApi
    if not report["login"]["ok"] and sessions_api_cls is not None:
        try:
            api = sessions_api_cls()
        except Exception as exc:
            login_errors.append(f"generated:SessionsApi() -> {short_error(exc)}")
            api = None
        if api is not None:
            for meth_name in ("login", "post_login", "create_session", "sessions_post"):
                meth = getattr(api, meth_name, None)
                if meth is None:
                    continue
                try:
                    session_obj = call_with_supported_kwargs(
                        meth, login, password, application=application
                    )
                    report["login"] = {
                        "ok": True,
                        "strategy": f"generated:SessionsApi.{meth_name}",
                        "error": None,
                    }
                    break
                except Exception as exc:
                    login_errors.append(f"generated:SessionsApi.{meth_name} -> {short_error(exc)}")

    if not report["login"]["ok"]:
        report["login"]["error"] = login_errors[:6]
        report["verdict"] = "login_failed"
        report["nextSteps"] = [
            "Login did not succeed with any documented signature on this SDK build.",
            "Common causes: (a) your CDMNext subscription has no API/Python entitlement, "
            "(b) an application ID is required \u2014 set CEIC_APPLICATION, "
            "(c) the installed client build expects a different signature.",
            "Send this redacted JSON to CEIC support and ask which login signature and "
            "application ID your account should use.",
            "Meanwhile the CDMNext Excel/CSV import path in China Monitor works today and "
            "needs no SDK at all.",
        ]
        print(json.dumps(report, indent=2))
        return 4

    report["session"] = {
        "type": type(session_obj).__name__ if session_obj is not None else "None",
        "token": redact_token(getattr(session_obj, "token", None) or getattr(session_obj, "id", None)),
    }

    # ── 4. Smallest possible subscribed search ───────────────────────────────
    search_result = None
    search_errors: list[str] = []
    search_candidates: list[tuple[str, Callable]] = []
    if Ceic is not None:
        for name in ("search", "search_series", "series_search"):
            fn = getattr(Ceic, name, None)
            if callable(fn):
                search_candidates.append((f"facade:{name}", fn))
    if series_api_cls is not None:
        try:
            series_api = series_api_cls()
            for name in ("search_series", "get_search_series", "series_search"):
                fn = getattr(series_api, name, None)
                if callable(fn):
                    search_candidates.append((f"generated:SeriesApi.{name}", fn))
        except Exception as exc:
            search_errors.append(f"generated:SeriesApi() -> {short_error(exc)}")

    for label, fn in search_candidates:
        try:
            search_result = call_with_supported_kwargs(
                fn,
                args.keyword,
                keyword=args.keyword,
                limit=args.limit,
                count=args.limit,
                subscribed_only=True,
                country="CN",
            )
            report["search"]["ok"] = True
            report["search"]["method"] = label
            break
        except Exception as exc:
            search_errors.append(f"{label} -> {short_error(exc)}")
    if not report["search"]["ok"]:
        report["search"]["error"] = search_errors[:6]

    # Pull one redacted identity out of whatever shape the search returned.
    sample_series_id = args.series
    if search_result is not None:
        try:
            items = getattr(getattr(search_result, "data", None), "items", None)
            if items is None and isinstance(search_result, dict):
                items = (search_result.get("data") or {}).get("items")
            if items:
                report["search"]["count"] = len(items)
                first = items[0]
                meta = getattr(first, "metadata", None) or (
                    first.get("metadata") if isinstance(first, dict) else None
                )
                sid = getattr(meta, "id", None) or (meta.get("id") if isinstance(meta, dict) else None)
                nm = getattr(meta, "name", None) or (meta.get("name") if isinstance(meta, dict) else None)
                report["search"]["sample"] = {"id": truncate(sid, 24), "name": truncate(nm, 60)}
                if sample_series_id is None and sid is not None:
                    sample_series_id = str(sid)
        except Exception as exc:
            report["search"]["error"] = short_error(exc)

    # ── 5. Metadata + timepoints for one series ──────────────────────────────
    if sample_series_id:
        meta_errors: list[str] = []
        meta_candidates: list[tuple[str, Callable]] = []
        if Ceic is not None:
            for name in ("series_metadata", "get_series_metadata", "metadata"):
                fn = getattr(Ceic, name, None)
                if callable(fn):
                    meta_candidates.append((f"facade:{name}", fn))
        if series_api_cls is not None:
            try:
                series_api = series_api_cls()
                for name in ("get_series_metadata", "series_metadata"):
                    fn = getattr(series_api, name, None)
                    if callable(fn):
                        meta_candidates.append((f"generated:SeriesApi.{name}", fn))
            except Exception:
                pass
        for label, fn in meta_candidates:
            try:
                md = call_with_supported_kwargs(fn, sample_series_id, id=sample_series_id)
                report["metadata"]["ok"] = True
                report["metadata"]["method"] = label
                report["metadata"]["sample"] = {
                    "id": truncate(sample_series_id, 24),
                    "type": type(md).__name__,
                }
                break
            except Exception as exc:
                meta_errors.append(f"{label} -> {short_error(exc)}")
        if not report["metadata"]["ok"]:
            report["metadata"]["error"] = meta_errors[:6]

        tp_errors: list[str] = []
        tp_candidates: list[tuple[str, Callable]] = []
        if Ceic is not None:
            for name in ("series", "get_series", "series_data", "get_series_time_points"):
                fn = getattr(Ceic, name, None)
                if callable(fn):
                    tp_candidates.append((f"facade:{name}", fn))
        if series_api_cls is not None:
            try:
                series_api = series_api_cls()
                for name in ("get_series_time_points", "get_series", "series_time_points"):
                    fn = getattr(series_api, name, None)
                    if callable(fn):
                        tp_candidates.append((f"generated:SeriesApi.{name}", fn))
            except Exception:
                pass
        for label, fn in tp_candidates:
            try:
                # CEIC's release notes state GET /series/{id} defaults to 3650
                # timepoints; a tiny count is enough to prove entitlement.
                res = call_with_supported_kwargs(fn, sample_series_id, id=sample_series_id, count=12, limit=12)
                dates = extract_dates(res)
                report["timepoints"]["ok"] = True
                report["timepoints"]["method"] = label
                report["timepoints"]["count"] = len(dates)
                report["timepoints"]["firstDate"] = dates[0] if dates else None
                report["timepoints"]["lastDate"] = dates[-1] if dates else None
                break
            except Exception as exc:
                tp_errors.append(f"{label} -> {short_error(exc)}")
        if not report["timepoints"]["ok"]:
            report["timepoints"]["error"] = tp_errors[:6]

    # ── 6. Capability sniffing (vintages / releases / async) ─────────────────
    def has_any(obj: Any, needles: tuple[str, ...]) -> bool | None:
        if obj is None:
            return None
        names = [n.lower() for n in dir(obj)]
        return any(any(nd in n for n in names) for nd in needles)

    probe_target = series_api_cls or Ceic
    report["capabilities"] = {
        "vintages": has_any(probe_target, ("vintage",)),
        "releases": has_any(probe_target, ("release",)),
        "async": has_any(probe_target, ("async_req", "_async", "async")),
    }

    # ── 7. Verdict ───────────────────────────────────────────────────────────
    if report["timepoints"]["ok"]:
        report["verdict"] = "ok"
        report["nextSteps"] = [
            "Login and data retrieval both work. Fill in manifest.json with real CEIC "
            "series IDs and logical IDs, then run: python3 collector.py --post",
            "Set CEIC_IMPORT_TOKEN (same value as on Railway) and CHINA_MONITOR_URL first.",
        ]
        rc = 0
    elif report["search"]["ok"] or report["metadata"]["ok"]:
        report["verdict"] = "login_ok_data_blocked"
        report["nextSteps"] = [
            "Login works but timepoint retrieval did not. Most likely the account is not "
            "entitled to API data delivery, or the series ID tried is not in your subscription.",
            "Re-run with an ID you can see in CDMNext: python3 probe.py --series <ID>",
            "If it still fails, use the CDMNext Excel/CSV import path in China Monitor.",
        ]
        rc = 5
    else:
        report["verdict"] = "login_ok_api_unusable"
        report["nextSteps"] = [
            "Login succeeded but neither search nor data calls worked on this SDK build.",
            "Send this redacted JSON to CEIC support. Use the CDMNext Excel/CSV import path "
            "in the meantime \u2014 it needs no SDK.",
        ]
        rc = 6

    print(json.dumps(report, indent=2))
    return rc


def extract_dates(res: Any) -> list[str]:
    """Pull ISO dates out of whichever timepoint shape the SDK returned."""
    out: list[str] = []
    candidates: Any = None
    for path in ("time_points", "timePoints"):
        candidates = getattr(res, path, None)
        if candidates:
            break
    if candidates is None:
        data = getattr(res, "data", None)
        if data is None and isinstance(res, dict):
            data = res.get("data")
        if isinstance(data, list) and data:
            first = data[0]
            candidates = getattr(first, "time_points", None) or (
                first.get("timePoints") if isinstance(first, dict) else None
            )
        elif data is not None:
            candidates = getattr(data, "time_points", None)
    if not candidates:
        return out
    for tp in candidates:
        d = getattr(tp, "_date", None) or getattr(tp, "date", None)
        if d is None and isinstance(tp, dict):
            d = tp.get("date") or tp.get("_date")
        if d is not None:
            out.append(str(d)[:10])
    return sorted(out)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:  # last-resort guard: still emit valid JSON
        print(
            json.dumps(
                {
                    "verdict": "probe_crashed",
                    "error": short_error(exc),
                    "traceback": traceback.format_exc(limit=3)[-800:],
                },
                indent=2,
            )
        )
        sys.exit(1)
