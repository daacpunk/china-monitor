import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Line } from "react-chartjs-2";
import { apiRequest } from "@/lib/queryClient";
import { baseChartOptions, CHART_COLORS } from "@/lib/charts";
import { ProvenanceChip } from "@/components/ProvenanceChip";

type Market = "ashare" | "hk";

interface OhlcvRow {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  turnover?: number;
  change_pct?: number;
}

interface AkshareResponse<T> {
  source: string;
  data: T[];
  fetchedAt: string;
  error?: string | null;
}

interface SectorRow {
  sector: string;
  change_pct_today: number;
  main_net_inflow: number;
  main_net_inflow_pct: number;
  top_stock_today?: string;
}

interface IncomeRow {
  报告日: string;
  营业总收入?: number | null;
  营业收入?: number | null;
  营业利润?: number | null;
  净利润?: number | null;
  归属于母公司所有者的净利润?: number | null;
  基本每股收益?: number | null;
  研发费用?: number | null;
}

const PRESETS: Record<Market, Array<{ symbol: string; label: string }>> = {
  ashare: [
    { symbol: "600519", label: "贵州茅台 Kweichow Moutai" },
    { symbol: "300750", label: "宁德时代 CATL" },
    { symbol: "002594", label: "比亚迪 BYD" },
    { symbol: "600036", label: "招商银行 CMB" },
    { symbol: "601318", label: "中国平安 Ping An" },
    { symbol: "688981", label: "中芯国际 SMIC" },
    { symbol: "300059", label: "东方财富 East Money" },
    { symbol: "002230", label: "科大讯飞 iFlytek" },
  ],
  hk: [
    { symbol: "00700", label: "Tencent" },
    { symbol: "09988", label: "Alibaba" },
    { symbol: "03690", label: "Meituan" },
    { symbol: "01810", label: "Xiaomi" },
    { symbol: "00939", label: "CCB" },
    { symbol: "01024", label: "Kuaishou" },
    { symbol: "09618", label: "JD.com" },
    { symbol: "03888", label: "Kingsoft" },
  ],
};

function useOhlcv(market: Market, symbol: string, start: string) {
  return useQuery<AkshareResponse<OhlcvRow>>({
    queryKey: ["/api/akshare", market, symbol, start],
    queryFn: async () => {
      const path = market === "ashare" ? "ashare" : "hk";
      const res = await apiRequest(
        "GET",
        `/api/akshare/${path}?symbol=${symbol}&start=${start}`,
      );
      return res.json();
    },
    staleTime: 60 * 60 * 1000, // 1h
    retry: 1,
  });
}

function useSectors(indicator: string) {
  return useQuery<AkshareResponse<SectorRow>>({
    queryKey: ["/api/akshare/sectors", indicator],
    queryFn: async () => {
      const qs = indicator ? `?indicator=${encodeURIComponent(indicator)}` : "";
      const res = await apiRequest("GET", `/api/akshare/sectors${qs}`);
      return res.json();
    },
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });
}

function useIncome(symbol: string, enabled: boolean) {
  return useQuery<AkshareResponse<IncomeRow>>({
    queryKey: ["/api/akshare/income", symbol],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/akshare/income?symbol=${symbol}`);
      return res.json();
    },
    enabled,
    staleTime: 24 * 60 * 60 * 1000, // 24h
    retry: 1,
  });
}

function formatRMB(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e12) return `¥${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e8) return `¥${(v / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `¥${(v / 1e4).toFixed(2)}万`;
  return `¥${v.toFixed(2)}`;
}

function defaultStart(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 2);
  return d.toISOString().slice(0, 10);
}

export default function EquityDeepDive() {
  const [market, setMarket] = useState<Market>("ashare");
  const [symbol, setSymbol] = useState("600519");
  const [pendingSymbol, setPendingSymbol] = useState("600519");
  const [start, setStart] = useState(defaultStart());

  const ohlcv = useOhlcv(market, symbol, start);
  const income = useIncome(market === "ashare" ? symbol : "", market === "ashare");
  const sectorsToday = useSectors("今日");

  const rows = ohlcv.data?.data ?? [];
  const last = rows[rows.length - 1];
  const first = rows[0];
  const periodChange =
    last && first ? ((last.close - first.close) / first.close) * 100 : null;

  const ccy = market === "ashare" ? "¥" : "HK$";

  const priceChart =
    rows.length > 0
      ? {
          datasets: [
            {
              label: `${symbol} close`,
              data: rows.map((r) => ({ x: r.date, y: r.close })),
              borderColor: CHART_COLORS.primary,
              backgroundColor: CHART_COLORS.primary + "15",
              fill: true,
              tension: 0.25,
              pointRadius: 0,
              parsing: { xAxisKey: "x", yAxisKey: "y" },
            },
          ],
        }
      : null;

  const volChart =
    rows.length > 0
      ? {
          datasets: [
            {
              label: "Volume",
              data: rows.map((r) => ({ x: r.date, y: r.volume })),
              borderColor: CHART_COLORS.muted,
              backgroundColor: CHART_COLORS.muted + "30",
              fill: true,
              tension: 0,
              pointRadius: 0,
              parsing: { xAxisKey: "x", yAxisKey: "y" },
            },
          ],
        }
      : null;

  const sectorRows = (sectorsToday.data?.data ?? []).slice().sort(
    (a, b) => (b.change_pct_today ?? 0) - (a.change_pct_today ?? 0),
  );

  const submitSymbol = () => {
    const s = pendingSymbol.trim();
    const isAshare = /^\d{6}$/.test(s);
    const isHk = /^\d{5}$/.test(s);
    if (isAshare) {
      setMarket("ashare");
      setSymbol(s);
    } else if (isHk) {
      setMarket("hk");
      setSymbol(s);
    }
  };

  return (
    <div data-testid="page-equity-deepdive">
      <PageHeader
        title="Equity Deep-Dive"
        subtitle="A-share + HK price action, sector capital flows, and fundamentals via AKShare."
        meta={
          <>
            <Badge variant="outline" className="font-normal">
              AKShare 1.18.64
            </Badge>
            {ohlcv.data?.fetchedAt && (
              <ProvenanceChip
                type="free"
                detail={`updated ${new Date(ohlcv.data.fetchedAt).toLocaleString()}`}
              />
            )}
          </>
        }
      />

      <Card className="p-4 mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Market
            </label>
            <Select value={market} onValueChange={(v) => setMarket(v as Market)}>
              <SelectTrigger className="w-[160px] h-9" data-testid="select-market">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ashare">A-share (6-digit)</SelectItem>
                <SelectItem value="hk">Hong Kong (5-digit)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Symbol
            </label>
            <div className="flex gap-2">
              <Input
                value={pendingSymbol}
                onChange={(e) => setPendingSymbol(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitSymbol()}
                placeholder={market === "ashare" ? "600519" : "00700"}
                className="w-[140px] h-9 font-mono"
                data-testid="input-symbol"
              />
              <Button size="sm" onClick={submitSymbol} data-testid="button-load-symbol">
                Load
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Start date
            </label>
            <Input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-[160px] h-9"
              data-testid="input-start-date"
            />
          </div>

          <div className="flex-1" />

          <div className="flex flex-col gap-1">
            <label className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Quick pick
            </label>
            <div className="flex flex-wrap gap-1.5 max-w-2xl">
              {PRESETS[market].map((p) => (
                <Button
                  key={p.symbol}
                  size="sm"
                  variant={symbol === p.symbol ? "default" : "outline"}
                  className="h-7 text-xs"
                  onClick={() => {
                    setSymbol(p.symbol);
                    setPendingSymbol(p.symbol);
                  }}
                  data-testid={`button-preset-${p.symbol}`}
                >
                  <span className="font-mono">{p.symbol}</span>
                  <span className="ml-1.5 text-muted-foreground">{p.label}</span>
                </Button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Price + Volume */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <Card className="p-5 lg:col-span-2" data-testid="card-price-chart">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold">
                {symbol} · {market === "ashare" ? "A-share" : "HK"}
              </h2>
              {last && (
                <div className="flex items-baseline gap-3 mt-1">
                  <span className="text-2xl font-semibold tabular-nums">
                    {ccy}
                    {last.close.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                  {periodChange != null && (
                    <span
                      className={`text-sm font-medium tabular-nums ${periodChange >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                    >
                      {periodChange >= 0 ? "+" : ""}
                      {periodChange.toFixed(2)}% since {first?.date}
                    </span>
                  )}
                </div>
              )}
            </div>
            <Badge variant="outline" className="font-normal">
              {rows.length} bars
            </Badge>
          </div>
          <div className="h-72">
            {ohlcv.isLoading && <Skeleton className="h-full w-full" />}
            {ohlcv.isError ||
              (ohlcv.data?.error && (
                <div className="text-sm text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md p-3">
                  AKShare upstream issue: {ohlcv.data?.error ?? (ohlcv.error as Error | null)?.message}.
                  EastMoney (the underlying source) is intermittently flaky. Retry in 30–60s.
                </div>
              ))}
            {priceChart && (
              <Line
                data={priceChart as any}
                options={
                  {
                    ...(baseChartOptions as any),
                    scales: {
                      ...((baseChartOptions as any).scales ?? {}),
                      x: { type: "time", time: { unit: "month" } },
                    },
                  } as any
                }
              />
            )}
          </div>
        </Card>

        <Card className="p-5" data-testid="card-volume-chart">
          <h2 className="text-sm font-semibold mb-3">Volume</h2>
          <div className="h-72">
            {ohlcv.isLoading && <Skeleton className="h-full w-full" />}
            {volChart && (
              <Line
                data={volChart as any}
                options={
                  {
                    ...(baseChartOptions as any),
                    plugins: {
                      ...((baseChartOptions as any).plugins ?? {}),
                      legend: { display: false },
                    },
                    scales: {
                      ...((baseChartOptions as any).scales ?? {}),
                      x: { type: "time", time: { unit: "month" } },
                    },
                  } as any
                }
              />
            )}
          </div>
        </Card>
      </div>

      {/* Sector heatmap + Income statement */}
      <Tabs defaultValue="sectors" className="mb-4">
        <TabsList>
          <TabsTrigger value="sectors" data-testid="tab-sectors">
            Sector capital flows (A-share)
          </TabsTrigger>
          <TabsTrigger
            value="fundamentals"
            data-testid="tab-fundamentals"
            disabled={market !== "ashare"}
          >
            Fundamentals (income statement)
          </TabsTrigger>
        </TabsList>

        <TabsContent value="sectors">
          <Card className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold">
                A-share industry capital flows · 今日
              </h2>
              <Badge variant="outline" className="font-normal">
                {sectorRows.length} sectors
              </Badge>
            </div>
            {sectorsToday.isLoading && <Skeleton className="h-64 w-full" />}
            {sectorRows.length > 0 && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Sector</TableHead>
                      <TableHead className="text-right">Change</TableHead>
                      <TableHead className="text-right">Net inflow</TableHead>
                      <TableHead className="text-right">% of turnover</TableHead>
                      <TableHead>Top stock</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sectorRows.slice(0, 25).map((s) => {
                      const intensity = Math.min(1, Math.abs(s.change_pct_today) / 4);
                      const bg =
                        s.change_pct_today >= 0
                          ? `rgba(16,185,129,${0.05 + intensity * 0.25})`
                          : `rgba(239,68,68,${0.05 + intensity * 0.25})`;
                      return (
                        <TableRow
                          key={s.sector}
                          data-testid={`row-sector-${s.sector}`}
                          style={{ background: bg }}
                        >
                          <TableCell className="font-medium">{s.sector}</TableCell>
                          <TableCell
                            className={`text-right tabular-nums font-medium ${s.change_pct_today >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                          >
                            {s.change_pct_today >= 0 ? "+" : ""}
                            {s.change_pct_today.toFixed(2)}%
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatRMB(s.main_net_inflow)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {s.main_net_inflow_pct != null
                              ? `${s.main_net_inflow_pct.toFixed(2)}%`
                              : "—"}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {s.top_stock_today ?? "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="fundamentals">
          <Card className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold">
                {symbol} · income statement (quarterly)
              </h2>
              <Badge variant="outline" className="font-normal">
                Source: Sina (via AKShare)
              </Badge>
            </div>
            {income.isLoading && <Skeleton className="h-64 w-full" />}
            {income.data?.data && income.data.data.length > 0 && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Period</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead className="text-right">Op. profit</TableHead>
                      <TableHead className="text-right">Net income</TableHead>
                      <TableHead className="text-right">Attributable NI</TableHead>
                      <TableHead className="text-right">R&amp;D</TableHead>
                      <TableHead className="text-right">EPS (basic)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {income.data.data.slice(0, 12).map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-mono text-xs">{r.报告日}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatRMB(r.营业总收入 ?? r.营业收入)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatRMB(r.营业利润)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatRMB(r.净利润)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatRMB(r.归属于母公司所有者的净利润)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatRMB(r.研发费用)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.基本每股收益 != null
                            ? `¥${r.基本每股收益.toFixed(2)}`
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
