"""
AKShare sidecar — FastAPI service exposing curated AKShare endpoints
for the china-monitor dashboard.

Auth: shared-secret header `X-AKShare-Token` (env: AKSHARE_TOKEN).
Cache: 24h TTL in-memory LRU per endpoint+args (matches main app TTL).

Endpoints:
  GET  /health                              — liveness (no auth)
  GET  /ashare/historical?symbol=&start=&end=  — A-share daily OHLCV
  GET  /hk/historical?symbol=&start=&end=      — HK Connect daily OHLCV
  GET  /sector/flows                        — sector money-flow snapshot
  GET  /financials/income?symbol=           — annual income statement

Symbol formats:
  A-share: 6-digit code, e.g. 600519 (Moutai), 000001 (PA Bank)
  HK:      5-digit code, e.g. 00700 (Tencent), 09988 (BABA HK)
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import akshare as ak
import pandas as pd
from cachetools import TTLCache
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

# ─── Config ────────────────────────────────────────────────────────────
AKSHARE_TOKEN = os.environ.get("AKSHARE_TOKEN", "")
CACHE_TTL_SECONDS = int(os.environ.get("AKSHARE_CACHE_TTL", "86400"))  # 24h
CACHE_MAX_ENTRIES = int(os.environ.get("AKSHARE_CACHE_MAX", "500"))
PORT = int(os.environ.get("PORT", "8000"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("akshare-sidecar")

if not AKSHARE_TOKEN:
    log.warning("AKSHARE_TOKEN not set — service will reject all auth'd requests")

app = FastAPI(
    title="china-monitor AKShare sidecar",
    version="1.0.0",
    docs_url="/docs",
    redoc_url=None,
)

# Single shared cache keyed by (endpoint, frozen kwargs)
cache: TTLCache = TTLCache(maxsize=CACHE_MAX_ENTRIES, ttl=CACHE_TTL_SECONDS)


# ─── Helpers ───────────────────────────────────────────────────────────
def require_auth(x_akshare_token: Optional[str]) -> None:
    """Validate the shared-secret header."""
    if not AKSHARE_TOKEN:
        # If no token configured, reject everything (fail-closed)
        raise HTTPException(status_code=503, detail="Service has no AKSHARE_TOKEN configured")
    if not x_akshare_token or x_akshare_token != AKSHARE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing X-AKShare-Token")


def cache_get_or_call(key: tuple, fn, *args, **kwargs):
    """24h TTL cache wrapper. Stores result on success.

    Empty results (None / empty list / empty dict) are NOT cached so a transient
    upstream failure doesn't poison the entry for the full 24h TTL."""
    if key in cache:
        log.info("cache HIT %s", key[:2])
        return cache[key]
    log.info("cache MISS %s", key[:2])
    result = fn(*args, **kwargs)
    is_empty = result is None or (hasattr(result, "__len__") and len(result) == 0)
    if not is_empty:
        cache[key] = result
    else:
        log.warning("not caching empty result for %s", key[:2])
    return result


def call_with_retry(fn, *, attempts: int = 3, base_delay: float = 0.8):
    """Call an AKShare fn with simple retry+backoff. Many EastMoney/Sina
    endpoints intermittently return empty/HTML (-> 'Expecting value' JSON
    parse errors); a retry usually succeeds."""
    last_exc = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as ex:  # noqa: BLE001
            last_exc = ex
            log.warning("ak call attempt %d/%d failed: %s", i + 1, attempts, ex)
            if i < attempts - 1:
                time.sleep(base_delay * (i + 1))
    raise last_exc


def df_to_ohlcv(df: pd.DataFrame, date_col: str = "日期") -> List[Dict[str, Any]]:
    """Convert an AKShare OHLCV-shaped DataFrame to JSON-safe records.

    AKShare returns Chinese column names. We normalise to lowercase English.
    """
    if df is None or df.empty:
        return []

    # Standard A-share/HK column name map
    col_map = {
        "日期": "date",
        "开盘": "open",
        "收盘": "close",
        "最高": "high",
        "最低": "low",
        "成交量": "volume",          # shares (A) / shares (HK)
        "成交额": "turnover",         # CNY (A) / HKD (HK)
        "振幅": "amplitude_pct",
        "涨跌幅": "change_pct",
        "涨跌额": "change",
        "换手率": "turnover_rate_pct",
    }
    df = df.rename(columns=col_map)

    # Normalise date column
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")

    # Drop any rows missing date/close
    df = df.dropna(subset=[c for c in ["date", "close"] if c in df.columns])

    # Keep only numeric-friendly columns + date
    out_cols = [c for c in ["date", "open", "high", "low", "close", "volume",
                            "turnover", "change_pct", "turnover_rate_pct"] if c in df.columns]
    return df[out_cols].to_dict(orient="records")


def normalise_start(start: Optional[str], default_years_back: int = 5) -> str:
    """Convert ISO date YYYY-MM-DD to AKShare's YYYYMMDD format."""
    if start:
        try:
            return datetime.strptime(start, "%Y-%m-%d").strftime("%Y%m%d")
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid start date '{start}' (need YYYY-MM-DD)")
    return (datetime.utcnow() - timedelta(days=365 * default_years_back)).strftime("%Y%m%d")


def normalise_end(end: Optional[str]) -> str:
    if end:
        try:
            return datetime.strptime(end, "%Y-%m-%d").strftime("%Y%m%d")
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid end date '{end}' (need YYYY-MM-DD)")
    return datetime.utcnow().strftime("%Y%m%d")


# ─── Routes ────────────────────────────────────────────────────────────
@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "service": "akshare-sidecar",
        "akshare_version": getattr(ak, "__version__", "unknown"),
        "cache_size": len(cache),
        "cache_ttl_seconds": CACHE_TTL_SECONDS,
        "auth_configured": bool(AKSHARE_TOKEN),
    }


@app.get("/ashare/historical")
def ashare_historical(
    symbol: str = Query(..., description="6-digit A-share code, e.g. 600519"),
    start: Optional[str] = Query(None, description="YYYY-MM-DD; default = 5y ago"),
    end: Optional[str] = Query(None, description="YYYY-MM-DD; default = today"),
    adjust: str = Query("qfq", description="Price adjustment: '' (none), 'qfq' (forward), 'hfq' (backward)"),
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """A-share daily OHLCV via ak.stock_zh_a_hist."""
    require_auth(x_akshare_token)

    if not symbol.isdigit() or len(symbol) != 6:
        raise HTTPException(status_code=400, detail="A-share symbol must be 6 digits")
    if adjust not in ("", "qfq", "hfq"):
        raise HTTPException(status_code=400, detail="adjust must be '', 'qfq', or 'hfq'")

    s = normalise_start(start)
    e = normalise_end(end)
    key = ("ashare", symbol, s, e, adjust)

    def fetch():
        t0 = time.time()
        df = ak.stock_zh_a_hist(symbol=symbol, period="daily", start_date=s, end_date=e, adjust=adjust)
        log.info("stock_zh_a_hist %s rows=%d in %.2fs", symbol, 0 if df is None else len(df), time.time() - t0)
        return df_to_ohlcv(df)

    try:
        rows = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("ashare_historical failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")

    return {
        "source": "akshare",
        "endpoint": "stock_zh_a_hist",
        "symbol": symbol,
        "adjust": adjust,
        "start": s,
        "end": e,
        "count": len(rows),
        "data": rows,
        "fetched_at": datetime.utcnow().isoformat() + "Z",
    }


@app.get("/hk/historical")
def hk_historical(
    symbol: str = Query(..., description="5-digit HK code, e.g. 00700"),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    adjust: str = Query("qfq"),
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """HK daily OHLCV via ak.stock_hk_hist."""
    require_auth(x_akshare_token)

    if not symbol.isdigit() or len(symbol) != 5:
        raise HTTPException(status_code=400, detail="HK symbol must be 5 digits (e.g. 00700)")
    if adjust not in ("", "qfq", "hfq"):
        raise HTTPException(status_code=400, detail="adjust must be '', 'qfq', or 'hfq'")

    s = normalise_start(start)
    e = normalise_end(end)
    key = ("hk", symbol, s, e, adjust)

    def fetch():
        t0 = time.time()
        df = ak.stock_hk_hist(symbol=symbol, period="daily", start_date=s, end_date=e, adjust=adjust)
        log.info("stock_hk_hist %s rows=%d in %.2fs", symbol, 0 if df is None else len(df), time.time() - t0)
        return df_to_ohlcv(df)

    try:
        rows = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("hk_historical failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")

    return {
        "source": "akshare",
        "endpoint": "stock_hk_hist",
        "symbol": symbol,
        "adjust": adjust,
        "start": s,
        "end": e,
        "count": len(rows),
        "data": rows,
        "fetched_at": datetime.utcnow().isoformat() + "Z",
    }


@app.get("/index/historical")
def index_historical(
    symbol: str = Query(..., description="AKShare index symbol, e.g. 'sz399006' (ChiNext), 'sh000300' (CSI 300), 'sh000001' (Shanghai Composite)"),
    start: Optional[str] = Query(None, description="YYYY-MM-DD; default = 5y ago"),
    end: Optional[str] = Query(None, description="YYYY-MM-DD; default = today"),
    period: str = Query("daily", description="'daily', 'weekly', or 'monthly'"),
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """China index OHLCV history via ak.stock_zh_index_daily_em (EastMoney source).

    Used as the primary source for indices that lack monthly history on Yahoo
    Finance (e.g. ChiNext sz399006). AKShare runs from inside Railway's China
    egress path on this sidecar, which bypasses the regional WAF blocking the
    EastMoney push2his endpoint from the main Node service's US egress.
    """
    require_auth(x_akshare_token)

    if period not in ("daily", "weekly", "monthly"):
        raise HTTPException(status_code=400, detail="period must be 'daily', 'weekly', or 'monthly'")

    s = normalise_start(start)
    e = normalise_end(end)
    key = ("index_hist", symbol, s, e, period)

    def fetch():
        t0 = time.time()
        # stock_zh_index_daily_em returns daily OHLCV in DataFrame form with
        # columns: date, open, close, high, low, volume, amount.
        df = ak.stock_zh_index_daily_em(symbol=symbol, start_date=s, end_date=e)
        log.info("stock_zh_index_daily_em %s rows=%d in %.2fs",
                 symbol, 0 if df is None else len(df), time.time() - t0)
        if df is None or df.empty:
            return []
        # Normalise: AKShare's _em variant returns lowercase English columns already.
        df = df.copy()
        if "date" in df.columns:
            df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
        # Resample to monthly/weekly if requested. Index by date for resample.
        if period in ("weekly", "monthly"):
            df["_dt"] = pd.to_datetime(df["date"])
            df = df.set_index("_dt")
            rule = "W-FRI" if period == "weekly" else "ME"  # month-end
            agg = {
                c: ("last" if c == "close"
                    else "first" if c == "open"
                    else "max" if c == "high"
                    else "min" if c == "low"
                    else "sum" if c in ("volume", "amount")
                    else "last")
                for c in df.columns if c != "date"
            }
            df = df.resample(rule).agg(agg).dropna(subset=["close"])
            df["date"] = df.index.strftime("%Y-%m-%d")
            df = df.reset_index(drop=True)
        out_cols = [c for c in ["date", "open", "high", "low", "close", "volume", "amount"] if c in df.columns]
        return df[out_cols].to_dict(orient="records")

    try:
        rows = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("index_historical failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")

    return {
        "source": "akshare",
        "endpoint": "stock_zh_index_daily_em",
        "symbol": symbol,
        "period": period,
        "start": s,
        "end": e,
        "count": len(rows),
        "data": rows,
        "fetched_at": datetime.utcnow().isoformat() + "Z",
    }


@app.get("/sector/flows")
def sector_flows(
    indicator: str = Query("今日", description="Time window: '今日', '5日', '10日'"),
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """Sector money-flow snapshot via ak.stock_sector_fund_flow_rank."""
    require_auth(x_akshare_token)

    if indicator not in ("今日", "5日", "10日"):
        raise HTTPException(status_code=400, detail="indicator must be '今日', '5日', or '10日'")

    key = ("sector_flows", indicator)

    def fetch():
        t0 = time.time()
        # sector_type options: '行业资金流' (industry) — this is the default
        df = call_with_retry(lambda: ak.stock_sector_fund_flow_rank(indicator=indicator, sector_type="行业资金流"))
        log.info("stock_sector_fund_flow_rank %s rows=%d in %.2fs",
                 indicator, 0 if df is None else len(df), time.time() - t0)
        if df is None or df.empty:
            return []
        # Normalise column names (Chinese → English)
        col_map = {
            "名称": "sector",
            "今日涨跌幅": "change_pct_today",
            "5日涨跌幅": "change_pct_5d",
            "10日涨跌幅": "change_pct_10d",
            "今日主力净流入-净额": "main_net_inflow",
            "今日主力净流入-净占比": "main_net_inflow_pct",
            "5日主力净流入-净额": "main_net_inflow_5d",
            "5日主力净流入-净占比": "main_net_inflow_5d_pct",
            "10日主力净流入-净额": "main_net_inflow_10d",
            "10日主力净流入-净占比": "main_net_inflow_10d_pct",
            "今日主力净流入最大股": "top_stock_today",
            "5日主力净流入最大股": "top_stock_5d",
            "10日主力净流入最大股": "top_stock_10d",
        }
        df = df.rename(columns=col_map)
        # Drop the ranked index column if present
        if "序号" in df.columns:
            df = df.drop(columns=["序号"])
        return df.to_dict(orient="records")

    try:
        rows = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("sector_flows failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")

    return {
        "source": "akshare",
        "endpoint": "stock_sector_fund_flow_rank",
        "indicator": indicator,
        "count": len(rows),
        "data": rows,
        "fetched_at": datetime.utcnow().isoformat() + "Z",
    }


@app.get("/financials/income")
def financials_income(
    symbol: str = Query(..., description="6-digit A-share code"),
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """Annual income statement via ak.stock_financial_report_sina (利润表)."""
    require_auth(x_akshare_token)

    if not symbol.isdigit() or len(symbol) != 6:
        raise HTTPException(status_code=400, detail="A-share symbol must be 6 digits")

    # Sina uses prefixed codes (sh/sz). Auto-derive.
    if symbol.startswith(("60", "68", "90")):
        prefixed = f"sh{symbol}"
    elif symbol.startswith(("00", "30", "20")):
        prefixed = f"sz{symbol}"
    else:
        prefixed = f"sh{symbol}"  # fallback

    key = ("income", prefixed)

    def fetch():
        t0 = time.time()
        df = ak.stock_financial_report_sina(stock=prefixed, symbol="利润表")
        log.info("stock_financial_report_sina %s rows=%d in %.2fs",
                 prefixed, 0 if df is None else len(df), time.time() - t0)
        if df is None or df.empty:
            return []
        # Columns are mostly Chinese line items; convert date column if present
        if "报告日" in df.columns:
            df["报告日"] = pd.to_datetime(df["报告日"], errors="coerce").dt.strftime("%Y-%m-%d")
        return df.to_dict(orient="records")

    try:
        rows = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("financials_income failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")

    return {
        "source": "akshare",
        "endpoint": "stock_financial_report_sina/利润表",
        "symbol": prefixed,
        "count": len(rows),
        "data": rows,
        "fetched_at": datetime.utcnow().isoformat() + "Z",
    }


@app.get("/financials/valuation")
def financials_valuation(
    symbol: str = Query(..., description="6-digit A-share code"),
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """Spot valuation snapshot for an A-share name: PE, PB, market cap, etc.

    Uses ak.stock_individual_info_em (东方财富 individual info), which returns a
    key/value table including 总市值 (total mkt cap), 流通市值, 市盈率(动)/(静), 市净率,
    行业, etc. Falls back gracefully to whatever fields are available.
    """
    require_auth(x_akshare_token)

    if not symbol.isdigit() or len(symbol) != 6:
        raise HTTPException(status_code=400, detail="A-share symbol must be 6 digits")

    key = ("valuation", symbol)

    def fetch():
        t0 = time.time()
        kv: Dict[str, Any] = {}

        # Primary: stock_value_em — single-symbol EastMoney valuation table with
        # PE(TTM)/PE(静)/市净率/市销率 + 总市值. Lightweight and reliable (one symbol),
        # unlike stock_individual_info_em (no PE, often empty) and the heavy
        # all-A-share snapshot (RemoteDisconnected). Latest row = current snapshot.
        try:
            v = call_with_retry(lambda: ak.stock_value_em(symbol=symbol), attempts=2)
            if v is not None and not v.empty:
                last = v.iloc[-1]
                for col in v.columns:
                    kv[str(col)] = last.get(col)
        except Exception as ex:
            log.warning("stock_value_em failed: %s", ex)

        # Cross-host fallback (Baidu 股市通) for any missing PE / PB / mkt cap.
        def baidu_latest(indicator):
            try:
                d = call_with_retry(
                    lambda: ak.stock_zh_valuation_baidu(
                        symbol=symbol, indicator=indicator, period="近一年"),
                    attempts=2)
                if d is not None and not d.empty and "value" in d.columns:
                    return float(d.sort_values(d.columns[0]).iloc[-1]["value"])
            except Exception as ex:
                log.warning("baidu %s failed: %s", indicator, ex)
            return None

        if kv.get("PE(TTM)") in (None, "", "-", "--"):
            b = baidu_latest("市盈率(TTM)")
            if b is not None:
                kv["PE(TTM)"] = b
        if kv.get("市净率") in (None, "", "-", "--"):
            b = baidu_latest("市净率")
            if b is not None:
                kv["市净率"] = b
        if kv.get("总市值") in (None, "", "-", "--"):
            b = baidu_latest("总市值")
            if b is not None:
                kv["总市值"] = b  # Baidu 总市值 in 亿元

        # Name / industry / shares — best-effort from individual_info (may be empty).
        try:
            df = call_with_retry(lambda: ak.stock_individual_info_em(symbol=symbol), attempts=1)
            if df is not None and not df.empty:
                cols = list(df.columns)
                ic, vc = cols[0], (cols[1] if len(cols) > 1 else cols[0])
                for _, row in df.iterrows():
                    k = str(row[ic])
                    if k not in kv or kv.get(k) in (None, "", "-"):
                        kv[k] = row[vc]
        except Exception as ex:
            log.warning("stock_individual_info_em (name/industry) failed: %s", ex)

        log.info("valuation %s keys=%d in %.2fs", symbol, len(kv), time.time() - t0)
        return kv

    try:
        kv = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("financials_valuation failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")

    import math as _math

    def _jsonsafe(x):
        """Coerce numpy/pandas scalars to plain JSON-safe values; NaN/Inf -> None."""
        try:
            import numpy as _np
            if isinstance(x, _np.generic):
                x = x.item()
        except Exception:
            pass
        if isinstance(x, float) and not _math.isfinite(x):
            return None
        return x

    def num(*keys):
        for k in keys:
            if k in kv:
                val = _jsonsafe(kv[k])
                if val in (None, "", "-", "--"):
                    continue
                try:
                    return float(val)
                except (TypeError, ValueError):
                    return val
        return None

    # Normalize the most useful fields (Chinese AKShare keys -> English).
    # Keys differ slightly between stock_individual_info_em and stock_bid_ask_em
    # so we probe several aliases for each metric.
    normalized = {
        "name": kv.get("股票简称") or kv.get("名称"),
        "industry": kv.get("行业"),
        "market_cap": num("总市值"),
        "float_market_cap": num("流通市值"),
        # PE/PB from stock_value_em ('PE(TTM)', 'PE(静)', '市净率', '市销率').
        "pe_ttm": num("PE(TTM)", "市盈率(TTM)", "市盈率-动态", "市盈率(动)", "市盈率"),
        "pe_static": num("PE(静)", "市盈率(静)", "市盈率-静态"),
        "pb": num("市净率"),
        "ps_ttm": num("市销率", "PS(TTM)"),
        "price": num("当日收盘价", "最新价", "最新", "最新价格", "收盘价"),
        "total_shares": num("总股本"),
        "float_shares": num("流通股"),
    }

    return {
        "source": "akshare",
        "endpoint": "stock_value_em",
        "symbol": symbol,
        "valuation": normalized,
        "raw": {str(k): _jsonsafe(val) for k, val in kv.items()},
        "fetched_at": datetime.utcnow().isoformat() + "Z",
    }


@app.get("/financials/valuation_history")
def financials_valuation_history(
    symbol: str = Query(..., description="6-digit A-share code"),
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """Dated PE(TTM)/PB history for an A-share name (for percentile-vs-history).

    Primary: ak.stock_value_em returns a multi-row dated table
    (数据日期 / PE(TTM) / 市净率 / 总市值 …). Fallback: ak.stock_zh_valuation_baidu
    (近十年) per indicator. Returns {data:[{date, pe_ttm, pb}]} ascending.
    """
    require_auth(x_akshare_token)
    if not symbol.isdigit() or len(symbol) != 6:
        raise HTTPException(status_code=400, detail="A-share symbol must be 6 digits")
    key = ("valuation_history", symbol)

    def fetch():
        import re as _re
        rows: List[Dict[str, Any]] = []
        # Primary: stock_value_em full history.
        try:
            v = call_with_retry(lambda: ak.stock_value_em(symbol=symbol), attempts=2)
            if v is not None and not v.empty:
                cols = list(v.columns)
                def find(*subs):
                    for s in subs:
                        for c in cols:
                            if s in str(c):
                                return c
                    return None
                dcol = find("数据日期", "日期")
                pecol = find("PE(TTM)", "市盈率(TTM)")
                pbcol = find("市净率")
                if dcol:
                    for _, r in v.iterrows():
                        m = _re.search(r"(\d{4})\D(\d{1,2})\D(\d{1,2})", str(r[dcol]))
                        d = (m.group(1) + "-" + m.group(2).zfill(2) + "-" + m.group(3).zfill(2)) if m else str(r[dcol])
                        def g(c):
                            try:
                                x = float(r[c]) if c else None
                                import math as _m
                                return x if (x is not None and _m.isfinite(x)) else None
                            except (TypeError, ValueError):
                                return None
                        rows.append({"date": d, "pe_ttm": g(pecol), "pb": g(pbcol)})
        except Exception as ex:
            log.warning("valuation_history stock_value_em failed: %s", ex)

        # Fallback: Baidu dated PE/PB series merged by date.
        if len(rows) < 30:
            def baidu_series(indicator):
                try:
                    d = call_with_retry(
                        lambda: ak.stock_zh_valuation_baidu(
                            symbol=symbol, indicator=indicator, period="近十年"),
                        attempts=2)
                    if d is not None and not d.empty and "value" in d.columns:
                        dc = d.columns[0]
                        return {str(r[dc])[:10]: float(r["value"]) for _, r in d.iterrows()
                                if str(r.get("value")) not in ("nan", "None", "")}
                except Exception as ex:
                    log.warning("baidu hist %s failed: %s", indicator, ex)
                return {}
            pe = baidu_series("市盈率(TTM)")
            pb = baidu_series("市净率")
            if pe or pb:
                dates = sorted(set(list(pe.keys()) + list(pb.keys())))
                rows = [{"date": d, "pe_ttm": pe.get(d), "pb": pb.get(d)} for d in dates]

        rows.sort(key=lambda r: r["date"])
        return rows

    try:
        rows = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("valuation_history failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")
    return {"source": "akshare", "symbol": symbol, "count": len(rows),
            "data": rows, "fetched_at": datetime.utcnow().isoformat() + "Z"}


@app.get("/financials/earnings")
def financials_earnings(
    symbol: str = Query(..., description="6-digit A-share code"),
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """Quarterly revenue / net-profit growth + EPS for an A-share name (Gap B).

    Source: ak.stock_financial_abstract_ths(symbol, indicator="按报告期").
    Chinese cols (values are STRINGS with 亿/% suffixes):
      报告期 (period 'YYYY-MM-DD'), 营业总收入 ('547.03亿'),
      营业总收入同比增长率 ('6.34%'), 净利润 ('272.43亿'),
      净利润同比增长率 ('1.47%'), 基本每股收益 ('21.7600').
    Returns the most recent ~8 quarters ascending by period with ASCII keys:
      {report_period, revenue, revenue_yoy, net_profit, net_profit_yoy, eps}
    Parse 亿 -> numeric value-in-亿, % -> float, EPS -> float; null on failure.
    """
    require_auth(x_akshare_token)
    if not symbol.isdigit() or len(symbol) != 6:
        raise HTTPException(status_code=400, detail="A-share symbol must be 6 digits")
    key = ("earnings", symbol)

    def fetch():
        import re as _re
        import math as _m

        def parse_yi(x):
            """'547.03亿' -> 547.03 (value in 亿); '1.2万亿' -> 12000.0."""
            if x is None:
                return None
            s = str(x).strip().replace(",", "")
            if s in ("", "nan", "None", "--", "-"):
                return None
            try:
                if "万亿" in s:
                    return float(_re.sub(r"[^\d.\-]", "", s)) * 10000.0
                if "亿" in s:
                    return float(_re.sub(r"[^\d.\-]", "", s))
                if "万" in s:
                    return float(_re.sub(r"[^\d.\-]", "", s)) / 10000.0
                v = float(_re.sub(r"[^\d.\-]", "", s))
                return v if _m.isfinite(v) else None
            except (TypeError, ValueError):
                return None

        def parse_pct(x):
            if x is None:
                return None
            s = str(x).strip().replace(",", "")
            if s in ("", "nan", "None", "--", "-"):
                return None
            try:
                v = float(_re.sub(r"[^\d.\-]", "", s))
                return v if _m.isfinite(v) else None
            except (TypeError, ValueError):
                return None

        def parse_float(x):
            if x is None:
                return None
            s = str(x).strip().replace(",", "")
            if s in ("", "nan", "None", "--", "-"):
                return None
            try:
                v = float(s)
                return v if _m.isfinite(v) else None
            except (TypeError, ValueError):
                return None

        df = call_with_retry(
            lambda: ak.stock_financial_abstract_ths(symbol=symbol, indicator="按报告期"),
            attempts=3)
        if df is None or df.empty:
            return []
        cols = list(df.columns)

        def find(*subs):
            for s in subs:
                for c in cols:
                    if s in str(c):
                        return c
            return None

        pcol = find("报告期")
        rev = find("营业总收入")
        rev_yoy = find("营业总收入同比增长率", "营业收入同比增长率")
        npf = find("净利润")
        np_yoy = find("净利润同比增长率")
        epscol = find("基本每股收益", "每股收益")
        if not pcol:
            return []

        rows: List[Dict[str, Any]] = []
        for _, r in df.iterrows():
            period = str(r[pcol]).strip()[:10] if pcol else None
            if not period or not _re.match(r"\d{4}-\d{2}-\d{2}", period):
                continue
            rows.append({
                "report_period": period,
                "revenue": parse_yi(r[rev]) if rev else None,
                "revenue_yoy": parse_pct(r[rev_yoy]) if rev_yoy else None,
                "net_profit": parse_yi(r[npf]) if npf else None,
                "net_profit_yoy": parse_pct(r[np_yoy]) if np_yoy else None,
                "eps": parse_float(r[epscol]) if epscol else None,
            })
        rows.sort(key=lambda x: x["report_period"])
        return rows[-8:]

    try:
        rows = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("earnings failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")
    return {"source": "akshare", "symbol": symbol, "count": len(rows),
            "data": rows, "fetched_at": datetime.utcnow().isoformat() + "Z"}


# ─── Macro series (NBS/EastMoney via AKShare; bypasses US-IP WAF) ───────────
def _macro_yoy_records(df: pd.DataFrame) -> List[Dict[str, Any]]:
    """Normalise an EastMoney cjsj macro DataFrame (cols 月份 / 当月 / 同比增长 ...)
    into [{date: 'YYYY-MM', value: <YoY %>}] sorted ascending.

    These ak.macro_china_cpi / ak.macro_china_ppi frames use Chinese columns:
      月份 (month, e.g. '2025年05月份'), 全国-同比增长 / 同比增长 (YoY %), etc.
    We pick the first column that looks like a national YoY figure.
    """
    if df is None or df.empty:
        return []
    df = df.copy()
    cols = list(df.columns)
    # Month column is usually the first one (月份).
    month_col = cols[0]
    # Prefer an explicit national YoY column; fall back to any 同比 column.
    yoy_candidates = [c for c in cols if ("同比" in str(c))]
    nat_yoy = [c for c in yoy_candidates if "全国" in str(c)]
    value_col = (nat_yoy or yoy_candidates or [cols[1] if len(cols) > 1 else cols[0]])[0]

    def parse_month(raw: Any) -> Optional[str]:
        s = str(raw)
        # Forms: '2025年05月份', '2025-05-01', '2025.05', '202505'
        import re
        m = re.search(r"(\d{4})\D*(\d{1,2})", s)
        if not m:
            return None
        y, mo = m.group(1), m.group(2).zfill(2)
        return f"{y}-{mo}"

    out: List[Dict[str, Any]] = []
    for _, row in df.iterrows():
        d = parse_month(row[month_col])
        if not d:
            continue
        try:
            v = float(row[value_col])
        except (TypeError, ValueError):
            continue
        out.append({"date": d, "value": v})
    # De-dupe by date (keep last) and sort ascending.
    seen: Dict[str, Dict[str, Any]] = {}
    for r in out:
        seen[r["date"]] = r
    return sorted(seen.values(), key=lambda r: r["date"])


@app.get("/macro/cpi")
def macro_cpi(
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """China CPI YoY % (monthly) via ak.macro_china_cpi (EastMoney cjsj)."""
    require_auth(x_akshare_token)
    key = ("macro_cpi",)

    def fetch():
        t0 = time.time()
        df = ak.macro_china_cpi()
        log.info("macro_china_cpi rows=%d in %.2fs", 0 if df is None else len(df), time.time() - t0)
        return _macro_yoy_records(df)

    try:
        rows = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("macro_cpi failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")
    return {"source": "akshare", "endpoint": "macro_china_cpi", "count": len(rows),
            "data": rows, "fetched_at": datetime.utcnow().isoformat() + "Z"}


@app.get("/macro/ppi")
def macro_ppi(
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """China PPI YoY % (monthly) via ak.macro_china_ppi (EastMoney cjsj)."""
    require_auth(x_akshare_token)
    key = ("macro_ppi",)

    def fetch():
        t0 = time.time()
        df = ak.macro_china_ppi()
        log.info("macro_china_ppi rows=%d in %.2fs", 0 if df is None else len(df), time.time() - t0)
        return _macro_yoy_records(df)

    try:
        rows = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("macro_ppi failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")
    return {"source": "akshare", "endpoint": "macro_china_ppi", "count": len(rows),
            "data": rows, "fetched_at": datetime.utcnow().isoformat() + "Z"}


def _macro_records_for_column(df, value_substrings, month_col=None):
    """Generic monthly-macro normaliser targeting a SPECIFIC column by substring
    (priority order). Used for PMI (level), M2 (YoY), retail (YoY).
    Returns [{date:'YYYY-MM', value:float}] ascending."""
    if df is None or df.empty:
        return []
    cols = list(df.columns)
    mcol = month_col if (month_col and month_col in cols) else cols[0]
    value_col = None
    for sub in value_substrings:
        for c in cols:
            if sub in str(c):
                value_col = c
                break
        if value_col:
            break
    if value_col is None:
        return []
    import re, math
    seen = {}
    for _, row in df.iterrows():
        m = re.search(r"(\d{4})\D*(\d{1,2})", str(row[mcol]))
        if not m:
            continue
        d = m.group(1) + "-" + m.group(2).zfill(2)
        try:
            v = float(row[value_col])
        except (TypeError, ValueError):
            continue
        # Skip NaN/Inf — they serialise to invalid JSON (literal NaN) which breaks
        # the Node JSON.parse on the consumer side, zeroing out the whole series.
        if not math.isfinite(v):
            continue
        seen[d] = {"date": d, "value": v}
    return sorted(seen.values(), key=lambda r: r["date"])


def _macro_release_records(df, date_substrings, value_substrings):
    """For jin10 'report' frames (e.g. macro_china_exports_yoy) with columns
    like 商品/日期/今值/预测值/前值. Maps 日期 (release date) → month and
    uses 今值 (actual) as the value. Skips NaN actuals (unreleased rows)."""
    if df is None or df.empty:
        return []
    cols = list(df.columns)

    def pick(subs):
        for s in subs:
            for c in cols:
                if s in str(c):
                    return c
        return None

    date_col = pick(date_substrings) or cols[0]
    val_col = pick(value_substrings)
    if val_col is None:
        return []
    import re, math
    seen = {}
    for _, row in df.iterrows():
        m = re.search(r"(\d{4})\D*(\d{1,2})", str(row[date_col]))
        if not m:
            continue
        d = m.group(1) + "-" + m.group(2).zfill(2)
        try:
            v = float(row[val_col])
        except (TypeError, ValueError):
            continue
        if math.isnan(v):
            continue
        seen[d] = {"date": d, "value": v}
    return sorted(seen.values(), key=lambda r: r["date"])


def _macro_endpoint(key_name, ak_fn_name, builder):
    """Shared wrapper: cached + retry + 502 on failure."""
    key = (key_name,)

    def fetch():
        t0 = time.time()
        fn = getattr(ak, ak_fn_name)
        df = call_with_retry(lambda: fn(), attempts=2)
        log.info("%s rows=%d in %.2fs", ak_fn_name, 0 if df is None else len(df), time.time() - t0)
        return builder(df)

    try:
        rows = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("%s failed", key_name)
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")
    return {"source": "akshare", "endpoint": ak_fn_name, "count": len(rows),
            "data": rows, "fetched_at": datetime.utcnow().isoformat() + "Z"}


@app.get("/macro/pmi")
def macro_pmi(x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token")):
    """China official Manufacturing PMI (level) via ak.macro_china_pmi."""
    require_auth(x_akshare_token)
    return _macro_endpoint(
        "macro_pmi", "macro_china_pmi",
        lambda df: _macro_records_for_column(df, ["制造业-指数", "制造业指数", "制造业"]),
    )


@app.get("/macro/m2")
def macro_m2(x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token")):
    """China M2 YoY % via ak.macro_china_money_supply."""
    require_auth(x_akshare_token)
    return _macro_endpoint(
        "macro_m2", "macro_china_money_supply",
        # Column is '货币和准货币(M2)-同比增长'. Avoid the '-数量' level column.
        lambda df: _macro_records_for_column(df, ["M2)-同比增长", "(M2)-同比增长"]),
    )


@app.get("/macro/retail")
def macro_retail(x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token")):
    """China retail sales monthly YoY % via ak.macro_china_consumer_goods_retail."""
    require_auth(x_akshare_token)

    def build(df):
        if df is None or df.empty:
            return []
        # Exact monthly YoY column is '同比增长'; the cumulative one is
        # '累计-同比增长'. Use exact-name match first, then substring fallback.
        if "同比增长" in df.columns:
            return _macro_records_for_column(df, ["同比增长"], month_col="月份")
        cols = [c for c in df.columns if "同比" in str(c) and "累计" not in str(c)]
        return _macro_records_for_column(df, [str(c) for c in cols]) if cols else []

    return _macro_endpoint("macro_retail", "macro_china_consumer_goods_retail", build)


@app.get("/macro/exports")
def macro_exports(x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token")):
    """China exports YoY % (USD) via ak.macro_china_hgjck (Customs, EastMoney cjsj).
    Targets the monthly '当月出口额-同比增长' column — this is current to the latest
    customs release, unlike the sparse jin10 macro_china_exports_yoy calendar."""
    require_auth(x_akshare_token)
    return _macro_endpoint(
        "macro_exports", "macro_china_hgjck",
        lambda df: _macro_records_for_column(
            df, ["当月出口额-同比增长", "当月出口额-同比"], month_col="月份"),
    )


@app.get("/macro/imports")
def macro_imports(x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token")):
    """China imports YoY % (USD) via ak.macro_china_hgjck (Customs, EastMoney cjsj).
    Targets the monthly '当月进口额-同比增长' column."""
    require_auth(x_akshare_token)
    return _macro_endpoint(
        "macro_imports", "macro_china_hgjck",
        lambda df: _macro_records_for_column(
            df, ["当月进口额-同比增长", "当月进口额-同比"], month_col="月份"),
    )


def _trade_balance_records(df):
    """Monthly trade balance in USD bn = (当月出口额-金额) - (当月进口额-金额).
    macro_china_hgjck amounts are in 亿美元 (100M USD) -> /10 to get USD bn."""
    if df is None or df.empty:
        return []
    cols = list(df.columns)

    def find(*subs):
        for s in subs:
            for c in cols:
                if s in str(c):
                    return c
        return None

    month_col = find("月份") or cols[0]
    exp_col = find("当月出口额-金额", "当月出口额")
    imp_col = find("当月进口额-金额", "当月进口额")
    if exp_col is None or imp_col is None:
        return []
    import re, math
    seen = {}
    for _, row in df.iterrows():
        m = re.search(r"(\d{4})\D*(\d{1,2})", str(row[month_col]))
        if not m:
            continue
        d = m.group(1) + "-" + m.group(2).zfill(2)
        try:
            exp = float(row[exp_col])
            imp = float(row[imp_col])
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(exp) and math.isfinite(imp)):
            continue
        # macro_china_hgjck raw amounts are in 千美元 (thousand USD): the May-2026
        # exp−imp difference is ≈ 1.05e8 千美元 = $105.4bn, matching the customs
        # release. So USD bn = (exp − imp) / 1e6.
        bal_bn = (exp - imp) / 1_000_000.0
        seen[d] = {"date": d, "value": round(bal_bn, 2)}
    return sorted(seen.values(), key=lambda r: r["date"])


@app.get("/macro/trade_balance")
def macro_trade_balance(x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token")):
    """China monthly trade balance in USD bn, derived from ak.macro_china_hgjck
    (当月出口额-金额 minus 当月进口额-金额)."""
    require_auth(x_akshare_token)
    return _macro_endpoint("macro_trade_balance", "macro_china_hgjck", _trade_balance_records)


def _long_format_records(df, item_value, item_col="item", date_col="date", val_col="value"):
    """For long-format frames (date, item, value) like
    macro_china_urban_unemployment. Keeps only rows where item == item_value,
    maps date (e.g. '202604') -> 'YYYY-MM'. NaN-safe."""
    if df is None or df.empty:
        return []
    cols = list(df.columns)
    if item_col not in cols or date_col not in cols or val_col not in cols:
        return []
    import re, math
    seen = {}
    for _, row in df.iterrows():
        if str(row[item_col]).strip() != item_value:
            continue
        m = re.search(r"(\d{4})\D*(\d{1,2})", str(row[date_col]))
        if not m:
            continue
        d = m.group(1) + "-" + m.group(2).zfill(2)
        try:
            v = float(row[val_col])
        except (TypeError, ValueError):
            continue
        if not math.isfinite(v):
            continue
        seen[d] = {"date": d, "value": v}
    return sorted(seen.values(), key=lambda r: r["date"])


@app.get("/macro/unemployment")
def macro_unemployment(x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token")):
    """China urban surveyed unemployment rate (%) via ak.macro_china_urban_unemployment.
    Long-format; keep item == '全国城镇调查失业率' (the headline national rate)."""
    require_auth(x_akshare_token)
    return _macro_endpoint(
        "macro_unemployment", "macro_china_urban_unemployment",
        lambda df: _long_format_records(df, "全国城镇调查失业率"),
    )


# ─── Flows & positioning (Gap C: northbound / margin / leverage) ────────────
def _flows_jsonsafe(x):
    """Coerce numpy/pandas scalars to plain JSON-safe values; NaN/Inf -> None."""
    import math as _math
    try:
        import numpy as _np
        if isinstance(x, _np.generic):
            x = x.item()
    except Exception:
        pass
    if isinstance(x, float) and not _math.isfinite(x):
        return None
    return x


def _col_finder(df: pd.DataFrame):
    """Return a fn(*substrings) -> first matching column name (or None)."""
    cols = list(df.columns)

    def find(*subs):
        for s in subs:
            for c in cols:
                if s in str(c):
                    return c
        return None

    return find


def _num_cell(row, col):
    if not col:
        return None
    try:
        v = float(row[col])
    except (TypeError, ValueError):
        return None
    return _flows_jsonsafe(v)


def _date_cell(row, col):
    if not col:
        return None
    import re as _re
    s = str(row[col])
    m = _re.search(r"(\d{4})\D?(\d{1,2})\D?(\d{1,2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"
    return s


@app.get("/flows/northbound")
def flows_northbound(
    limit: int = Query(250, description="Recent rows to return (most recent N)"),
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """Northbound (Stock Connect, 北向资金) daily history via ak.stock_hsgt_hist_em.

    Source cols: 日期, 当日成交净买额, 买入成交额, 卖出成交额, 历史累计净买额,
    当日资金流入, 当日余额, 持股市值. Returns a recent series (ascending) + latest
    snapshot. Net buy / cumulative / holdings are the PRIMARY positioning signal.
    """
    require_auth(x_akshare_token)
    key = ("flows_northbound",)

    def fetch():
        t0 = time.time()
        df = call_with_retry(lambda: ak.stock_hsgt_hist_em(symbol="北向资金"), attempts=2)
        log.info("stock_hsgt_hist_em rows=%d in %.2fs",
                 0 if df is None else len(df), time.time() - t0)
        if df is None or df.empty:
            return []
        find = _col_finder(df)
        dcol = find("日期")
        netcol = find("当日成交净买额", "成交净买额")
        cumcol = find("历史累计净买额", "累计净买额")
        mvcol = find("持股市值")
        inflowcol = find("当日资金流入")
        balcol = find("当日余额")
        rows: List[Dict[str, Any]] = []
        for _, r in df.iterrows():
            rows.append({
                "date": _date_cell(r, dcol),
                "daily_net_buy": _num_cell(r, netcol),
                "cumulative_net_buy": _num_cell(r, cumcol),
                "holdings_mktval": _num_cell(r, mvcol),
                "daily_inflow": _num_cell(r, inflowcol),
                "balance": _num_cell(r, balcol),
            })
        rows = [x for x in rows if x["date"]]
        rows.sort(key=lambda x: x["date"])
        return rows

    try:
        rows = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("flows_northbound failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")

    n = max(1, min(int(limit or 250), len(rows))) if rows else 0
    recent = rows[-n:] if rows else []
    latest = recent[-1] if recent else None
    return {
        "source": "akshare",
        "endpoint": "stock_hsgt_hist_em",
        "symbol": "北向资金",
        "count": len(recent),
        "data": recent,
        "latest": latest,
        "fetched_at": datetime.utcnow().isoformat() + "Z",
    }


@app.get("/flows/northbound_summary")
def flows_northbound_summary(
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """Today's Stock Connect fund-flow summary via ak.stock_hsgt_fund_flow_summary_em.

    Source cols: 交易日, 类型, 板块, 资金方向, 交易状态, 成交净买额, 资金净流入,
    当日资金余额. Returns one ASCII row per board/direction.
    """
    require_auth(x_akshare_token)
    key = ("flows_northbound_summary",)

    def fetch():
        t0 = time.time()
        df = call_with_retry(lambda: ak.stock_hsgt_fund_flow_summary_em(), attempts=2)
        log.info("stock_hsgt_fund_flow_summary_em rows=%d in %.2fs",
                 0 if df is None else len(df), time.time() - t0)
        if df is None or df.empty:
            return []
        find = _col_finder(df)
        dcol = find("交易日")
        typecol = find("类型")
        boardcol = find("板块")
        dircol = find("资金方向")
        netbuycol = find("成交净买额")
        netinflowcol = find("资金净流入")
        balcol = find("当日资金余额", "资金余额")
        rows: List[Dict[str, Any]] = []
        for _, r in df.iterrows():
            rows.append({
                "trade_date": _date_cell(r, dcol),
                "type": (str(r[typecol]) if typecol else None),
                "board": (str(r[boardcol]) if boardcol else None),
                "direction": (str(r[dircol]) if dircol else None),
                "net_buy": _num_cell(r, netbuycol),
                "net_inflow": _num_cell(r, netinflowcol),
                "balance": _num_cell(r, balcol),
            })
        return rows

    try:
        rows = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("flows_northbound_summary failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")

    return {
        "source": "akshare",
        "endpoint": "stock_hsgt_fund_flow_summary_em",
        "count": len(rows),
        "data": rows,
        "fetched_at": datetime.utcnow().isoformat() + "Z",
    }


@app.get("/flows/margin")
def flows_margin(
    limit: int = Query(250, description="Recent rows to return (most recent N)"),
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """Market-wide margin / leverage via ak.stock_margin_account_info, plus a
    best-effort SH detail series via ak.stock_margin_sse.

    Market cols: 日期, 融资余额, 融券余额, 融资买入额, 融券卖出额, 证券公司数量,
    营业部数量, 个人投资者数量. Returns recent series (ascending) + latest snapshot.
    """
    require_auth(x_akshare_token)
    key = ("flows_margin",)

    def fetch():
        t0 = time.time()
        df = call_with_retry(lambda: ak.stock_margin_account_info(), attempts=2)
        log.info("stock_margin_account_info rows=%d in %.2fs",
                 0 if df is None else len(df), time.time() - t0)
        if df is None or df.empty:
            return []
        find = _col_finder(df)
        dcol = find("日期")
        finbalcol = find("融资余额")
        shortbalcol = find("融券余额")
        finbuycol = find("融资买入额")
        shortsellcol = find("融券卖出额")
        rows: List[Dict[str, Any]] = []
        for _, r in df.iterrows():
            rows.append({
                "date": _date_cell(r, dcol),
                "financing_balance": _num_cell(r, finbalcol),
                "short_balance": _num_cell(r, shortbalcol),
                "financing_buy": _num_cell(r, finbuycol),
                "short_sell": _num_cell(r, shortsellcol),
            })
        rows = [x for x in rows if x["date"]]
        rows.sort(key=lambda x: x["date"])
        return rows

    def fetch_sse():
        # SH-only credit-trading detail; best-effort (may SSL/parse fail).
        end = datetime.utcnow().strftime("%Y%m%d")
        start = (datetime.utcnow() - timedelta(days=400)).strftime("%Y%m%d")
        df = call_with_retry(lambda: ak.stock_margin_sse(start_date=start, end_date=end), attempts=2)
        if df is None or df.empty:
            return []
        find = _col_finder(df)
        dcol = find("信用交易日期", "交易日期", "日期")
        finbalcol = find("融资余额")
        finbuycol = find("融资买入额")
        totalcol = find("融资融券余额")
        rows: List[Dict[str, Any]] = []
        for _, r in df.iterrows():
            rows.append({
                "date": _date_cell(r, dcol),
                "financing_balance": _num_cell(r, finbalcol),
                "financing_buy": _num_cell(r, finbuycol),
                "total_margin_balance": _num_cell(r, totalcol),
            })
        rows = [x for x in rows if x["date"]]
        rows.sort(key=lambda x: x["date"])
        return rows

    try:
        rows = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("flows_margin failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")

    # SH detail is best-effort: never fail the whole endpoint if it errors.
    sse_rows: List[Dict[str, Any]] = []
    sse_note = None
    try:
        sse_rows = cache_get_or_call(("flows_margin_sse",), fetch_sse)
    except Exception as ex:
        log.warning("flows_margin sse detail failed: %s", ex)
        sse_note = f"SH detail unavailable: {ex}"

    n = max(1, min(int(limit or 250), len(rows))) if rows else 0
    recent = rows[-n:] if rows else []
    latest = recent[-1] if recent else None
    sse_recent = sse_rows[-n:] if sse_rows else []
    out = {
        "source": "akshare",
        "endpoint": "stock_margin_account_info",
        "count": len(recent),
        "data": recent,
        "latest": latest,
        "sse_detail": sse_recent,
        "fetched_at": datetime.utcnow().isoformat() + "Z",
    }
    if sse_note:
        out["sse_note"] = sse_note
    return out


# ─── Relative & global context (Gap F: AH premium / cross-asset yields) ──────
@app.get("/relative/ah_premium")
def relative_ah_premium(
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """A-share vs H-share premium for dual-listed (AH) names via ak.stock_zh_ah_spot.

    The AKShare AH spot frame carries, per dual-listed pair, the A-share latest
    price, the H-share latest price (HKD), and a precomputed premium ratio (比价).
    Column names are Chinese and have varied across AKShare versions, so we probe
    by substring rather than assume an exact schema:
      代码/名称, 最新价 (A latest), H股-最新价 / H股价 (H latest, HKD),
      比价 (A/H price ratio), 溢价 / 溢价率 (premium %), 涨跌幅.
    Returns the median premium across pairs (honest aggregate), pair count, and
    the top / bottom names by premium. A `note` records the formula actually used.
    """
    require_auth(x_akshare_token)
    key = ("relative_ah_premium",)

    def fetch():
        t0 = time.time()
        df = call_with_retry(lambda: ak.stock_zh_ah_spot(), attempts=2)
        log.info("stock_zh_ah_spot rows=%d in %.2fs",
                 0 if df is None else len(df), time.time() - t0)
        if df is None or df.empty:
            return {}
        find = _col_finder(df)
        code_col = find("代码")
        name_col = find("名称")
        # Precomputed premium % column if AKShare provides one.
        prem_col = find("溢价率", "溢价")
        # Otherwise derive from the A/H price ratio (比价) or raw A & H prices.
        ratio_col = find("比价")
        a_price_col = find("最新价")
        h_price_col = find("H股-最新价", "H股价", "H股最新价", "H股")

        pairs: List[Dict[str, Any]] = []
        note_formula = None
        for _, r in df.iterrows():
            name = (str(r[name_col]).strip() if name_col else None)
            code = (str(r[code_col]).strip() if code_col else None)
            premium = None
            if prem_col:
                premium = _num_cell(r, prem_col)
                note_formula = note_formula or f"premium from AKShare '{prem_col}' column (percent)"
            if premium is None and ratio_col:
                # 比价 is the A/H price ratio; premium % = (ratio - 1) * 100.
                ratio = _num_cell(r, ratio_col)
                if ratio is not None and ratio > 0:
                    premium = (ratio - 1.0) * 100.0
                    note_formula = note_formula or f"premium = ('{ratio_col}' A/H ratio - 1) x 100"
            if premium is None and a_price_col and h_price_col:
                a_px = _num_cell(r, a_price_col)
                h_px = _num_cell(r, h_price_col)
                # H price is in HKD; without an FX leg this ratio overstates the
                # premium by the HKD->CNY rate (~0.91). We flag that in the note.
                if a_px is not None and h_px is not None and h_px > 0:
                    premium = (a_px / h_px - 1.0) * 100.0
                    note_formula = note_formula or (
                        f"premium = ('{a_price_col}' / '{h_price_col}' - 1) x 100; "
                        "H price is HKD (no FX conversion applied)")
            if premium is None or not isinstance(premium, (int, float)):
                continue
            premium = _flows_jsonsafe(float(premium))
            if premium is None:
                continue
            pairs.append({"name": name, "code": code, "premium_pct": round(premium, 2)})

        if not pairs:
            return {}
        prems = sorted(p["premium_pct"] for p in pairs)
        n = len(prems)
        median = prems[n // 2] if n % 2 == 1 else (prems[n // 2 - 1] + prems[n // 2]) / 2.0
        by_prem = sorted(pairs, key=lambda p: p["premium_pct"], reverse=True)
        return {
            "aggregate_premium_pct": round(median, 2),
            "pair_count": n,
            "top_premium": by_prem[:8],
            "bottom_premium": list(reversed(by_prem[-8:])),
            "note": note_formula or "premium computed per available columns",
            "as_of": datetime.utcnow().isoformat() + "Z",
        }

    try:
        result = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("relative_ah_premium failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")

    payload = {
        "source": "akshare",
        "endpoint": "stock_zh_ah_spot",
        "fetched_at": datetime.utcnow().isoformat() + "Z",
    }
    payload.update(result or {})
    return payload


@app.get("/relative/yields")
def relative_yields(
    start: Optional[str] = Query(None, description="YYYY-MM-DD; default 2025-01-01"),
    limit: int = Query(260, description="Recent rows to return (most recent N)"),
    x_akshare_token: Optional[str] = Header(None, alias="X-AKShare-Token"),
) -> Dict[str, Any]:
    """China vs US treasury yield curve via ak.bond_zh_us_rate.

    Source cols (Chinese): 日期, 中国国债收益率2年/5年/10年/30年,
    中国国债收益率10年-2年, 美国国债收益率2年/5年/10年/30年, 美国国债收益率10年-2年.
    We map to ASCII keys, add a computed us_cn_10y_diff (US 10y - CN 10y) per row
    (a CNY-pressure gauge), and return the recent series + the latest snapshot.
    """
    require_auth(x_akshare_token)
    s = "20250101"
    if start:
        try:
            s = datetime.strptime(start, "%Y-%m-%d").strftime("%Y%m%d")
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid start date '{start}' (need YYYY-MM-DD)")
    key = ("relative_yields", s)

    def fetch():
        t0 = time.time()
        df = call_with_retry(lambda: ak.bond_zh_us_rate(start_date=s), attempts=2)
        log.info("bond_zh_us_rate rows=%d in %.2fs",
                 0 if df is None else len(df), time.time() - t0)
        if df is None or df.empty:
            return []
        find = _col_finder(df)
        dcol = find("日期")
        cn2 = find("中国国债收益率2年")
        cn5 = find("中国国债收益率5年")
        cn10 = find("中国国债收益率10年-2年")  # spread col probed first to exclude below
        cn10y = find("中国国债收益率10年")
        cn30 = find("中国国债收益率30年")
        cn_spread = find("中国国债收益率10年-2年")
        us2 = find("美国国债收益率2年")
        us5 = find("美国国债收益率5年")
        us10y = find("美国国债收益率10年")
        us30 = find("美国国债收益率30年")
        us_spread = find("美国国债收益率10年-2年")
        # cn10y/us10y must be the pure 10年 column, not the 10年-2年 spread.
        # _col_finder returns the FIRST substring match; '中国国债收益率10年' also
        # matches '中国国债收益率10年-2年', so re-resolve by exact-ish preference.
        cols = list(df.columns)
        def exact10(prefix):
            cand = [c for c in cols if str(c).startswith(prefix) and "-" not in str(c)]
            return cand[0] if cand else None
        cn10y = exact10("中国国债收益率10年") or cn10y
        us10y = exact10("美国国债收益率10年") or us10y

        rows: List[Dict[str, Any]] = []
        for _, r in df.iterrows():
            cn_10 = _num_cell(r, cn10y)
            us_10 = _num_cell(r, us10y)
            diff = None
            if cn_10 is not None and us_10 is not None:
                diff = round(us_10 - cn_10, 3)
            rows.append({
                "date": _date_cell(r, dcol),
                "cn_2y": _num_cell(r, cn2),
                "cn_5y": _num_cell(r, cn5),
                "cn_10y": cn_10,
                "cn_30y": _num_cell(r, cn30),
                "cn_10y_2y": _num_cell(r, cn_spread),
                "us_2y": _num_cell(r, us2),
                "us_5y": _num_cell(r, us5),
                "us_10y": us_10,
                "us_30y": _num_cell(r, us30),
                "us_10y_2y": _num_cell(r, us_spread),
                "us_cn_10y_diff": diff,
            })
        rows = [x for x in rows if x["date"]]
        rows.sort(key=lambda x: x["date"])
        return rows

    try:
        rows = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("relative_yields failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")

    n = max(1, min(int(limit or 260), len(rows))) if rows else 0
    recent = rows[-n:] if rows else []
    latest = recent[-1] if recent else None
    return {
        "source": "akshare",
        "endpoint": "bond_zh_us_rate",
        "start": s,
        "count": len(recent),
        "data": recent,
        "latest": latest,
        "fetched_at": datetime.utcnow().isoformat() + "Z",
    }


@app.exception_handler(HTTPException)
def http_exception_handler(_request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail, "status": exc.status_code},
    )


if __name__ == "__main__":
    import uvicorn
    # Bind host is configurable:
    #   - Railway private networking is IPv6-only between services, so there we
    #     set BIND_HOST=:: (dual-stack).
    #   - On a standalone VPS, a '::' socket can be IPv6-only (sysctl
    #     net.ipv6.bindv6only=1), so Docker's IPv4 port mapping reaches TCP but
    #     not HTTP. Default to 0.0.0.0 (IPv4) which Docker maps correctly.
    bind_host = os.environ.get("BIND_HOST", "0.0.0.0")
    log.info("Starting akshare-sidecar on %s:%d (auth=%s, cache_ttl=%ds)",
             bind_host, PORT, "yes" if AKSHARE_TOKEN else "NO", CACHE_TTL_SECONDS)
    uvicorn.run("main:app", host=bind_host, port=PORT, log_level="info")
