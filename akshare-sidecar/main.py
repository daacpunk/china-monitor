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
    """24h TTL cache wrapper. Stores result on success."""
    if key in cache:
        log.info("cache HIT %s", key[:2])
        return cache[key]
    log.info("cache MISS %s", key[:2])
    result = fn(*args, **kwargs)
    cache[key] = result
    return result


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
        df = ak.stock_sector_fund_flow_rank(indicator=indicator, sector_type="行业资金流")
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


@app.exception_handler(HTTPException)
def http_exception_handler(_request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail, "status": exc.status_code},
    )


if __name__ == "__main__":
    import uvicorn
    log.info("Starting akshare-sidecar on port %d (auth=%s, cache_ttl=%ds)",
             PORT, "yes" if AKSHARE_TOKEN else "NO", CACHE_TTL_SECONDS)
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, log_level="info")
