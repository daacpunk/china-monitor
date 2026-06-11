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
        # Primary: EastMoney individual info (key/value table). This endpoint is
        # currently flaky (intermittent empty/HTML -> 'Expecting value'); if it
        # fails after retries, fall back to the all-A-share spot snapshot which
        # is served from a different EastMoney path and stays reliable.
        try:
            df = call_with_retry(lambda: ak.stock_individual_info_em(symbol=symbol), attempts=2)
            if df is not None and not df.empty:
                cols = list(df.columns)
                item_col = cols[0]
                val_col = cols[1] if len(cols) > 1 else cols[0]
                for _, row in df.iterrows():
                    kv[str(row[item_col])] = row[val_col]
        except Exception as ex:
            log.warning("stock_individual_info_em failed, trying spot fallback: %s", ex)

        # stock_individual_info_em has NO PE/PB. Always enrich with the all-A-share
        # spot snapshot (stock_zh_a_spot_em) which carries 市盈率-动态 / 市净率 /
        # 总市值 / 流通市值 / 最新价 / 名称, filtered to this symbol. This is served from a
        # different EastMoney path and stays reliable when individual_info 502s.
        try:
            spot = call_with_retry(lambda: ak.stock_zh_a_spot_em(), attempts=2)
            if spot is not None and not spot.empty and "代码" in spot.columns:
                row = spot[spot["代码"] == symbol]
                if not row.empty:
                    r0 = row.iloc[0]
                    for col in spot.columns:
                        # Don't overwrite non-empty info-em values with spot ones,
                        # but spot is the only source of PE/PB so add those.
                        if col not in kv or kv.get(col) in (None, "", "-"):
                            kv[str(col)] = r0[col]
        except Exception as ex:
            log.warning("stock_zh_a_spot_em enrich failed: %s", ex)

        # Last resort for PE/PB: Legulegu indicator series (Sina/legulegu host,
        # not EastMoney) — returns daily pe/pe_ttm/pb/ps/dv_ratio/total_mv.
        if kv.get("市盈率-动态") in (None, "", "-") and kv.get("市净率") in (None, "", "-"):
            try:
                ind = call_with_retry(
                    lambda: ak.stock_a_indicator_lg(symbol=symbol), attempts=2)
                if ind is not None and not ind.empty:
                    last = ind.sort_values(ind.columns[0]).iloc[-1]
                    # columns: trade_date, pe, pe_ttm, pb, ps, ps_ttm, dv_ratio, dv_ttm, total_mv
                    if "pe_ttm" in ind.columns:
                        kv.setdefault("市盈率-动态", last.get("pe_ttm"))
                    if "pb" in ind.columns:
                        kv.setdefault("市净率", last.get("pb"))
                    if "total_mv" in ind.columns and kv.get("总市值") in (None, "", "-"):
                        # total_mv is in 万元 (10k CNY) -> convert to 元
                        try:
                            kv["总市值"] = float(last.get("total_mv")) * 1e4
                        except (TypeError, ValueError):
                            pass
            except Exception as ex:
                log.warning("stock_a_indicator_lg fallback failed: %s", ex)

        log.info("valuation %s keys=%d in %.2fs", symbol, len(kv), time.time() - t0)
        return kv

    try:
        kv = cache_get_or_call(key, fetch)
    except Exception as ex:
        log.exception("financials_valuation failed")
        raise HTTPException(status_code=502, detail=f"AKShare upstream error: {ex}")

    def num(*keys):
        for k in keys:
            if k in kv and kv[k] not in (None, "", "-"):
                try:
                    return float(kv[k])
                except (TypeError, ValueError):
                    return kv[k]
        return None

    # Normalize the most useful fields (Chinese AKShare keys -> English).
    # Keys differ slightly between stock_individual_info_em and stock_bid_ask_em
    # so we probe several aliases for each metric.
    normalized = {
        "name": kv.get("股票简称") or kv.get("名称"),
        "industry": kv.get("行业"),
        "market_cap": num("总市值"),
        "float_market_cap": num("流通市值"),
        # PE/PB come from stock_zh_a_spot_em: '市盈率-动态', '市净率'.
        "pe_ttm": num("市盈率-动态", "市盈率(动)", "市盈率(TTM)", "市盈率"),
        "pe_static": num("市盈率(静)", "市盈率-静态"),
        "pb": num("市净率"),
        "price": num("最新价", "最新", "最新价格"),
        "total_shares": num("总股本"),
        "float_shares": num("流通股"),
    }

    return {
        "source": "akshare",
        "endpoint": "stock_individual_info_em",
        "symbol": symbol,
        "valuation": normalized,
        "raw": kv,
        "fetched_at": datetime.utcnow().isoformat() + "Z",
    }


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
    # Bind to :: (dual-stack IPv4+IPv6). Railway private networking is
    # IPv6-only between services, so binding 0.0.0.0 alone breaks intra-project calls.
    uvicorn.run("main:app", host="::", port=PORT, log_level="info")
