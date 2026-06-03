/**
 * Trends — multi-timescale slope analysis page.
 *
 * Session 1: header + picker + summary cards + classification table.
 * Session 2: per-series detail view (chart with regime markers + regression
 * overlays, interpretation panel, AI commentary).
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useSeriesRegistry } from "@/hooks/useSeries";

import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ArrowDown,
  ArrowUp,
  Minus,
  Plus,
  X,
  Zap,
  Loader2,
} from "lucide-react";
import { TrendDetail } from "@/components/TrendDetail";

// ─── Types matching server/analysis/trends.ts ────────────────────────────────

type Classification =
  | "stable"
  | "emerging"
  | "accelerating"
  | "decelerating"
  | "reversing"
  | "broken";

interface SlopePack {
  window: number;
  slope: number;
  slopePerYear: number;
  r2: number;
  startValue: number;
  endValue: number;
  pctChange: number;
}

interface RegimeShift {
  detected: boolean;
  date: string | null;
  zScore: number;
  direction: "up" | "down" | null;
  severity: "watch" | "anomaly" | null;
  windowMean: number;
  windowStd: number;
}

interface TrendResult {
  id: string;
  latestDate: string | null;
  latestValue: number | null;
  nObs: number;
  slopes: {
    s3: SlopePack | null;
    s6: SlopePack | null;
    s12: SlopePack | null;
  };
  regimeShift: RegimeShift;
  classification: Classification;
  trendStart: string | null;
  multiscaleConfirmed: boolean;
}

interface TrendsResponse {
  results: TrendResult[];
  summary: {
    up: number;
    down: number;
    flat: number;
    confirmation: Record<string, string[]>;
  };
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_IDS = [
  "ppi_yoy",
  "cpi_yoy",
  "m2_yoy",
  "iva_yoy",
  "exports_yoy",
  "usdcny_monthly",
  "oecd_cli_china",
  "csi300_monthly",
  "hangseng_monthly",
  "chinext_monthly",
];

const CLASSIFICATION_META: Record<
  Classification,
  { label: string; tone: string; desc: string }
> = {
  accelerating: {
    label: "Accelerating",
    tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    desc: "Slope rising over 12m; same sign across windows.",
  },
  decelerating: {
    label: "Decelerating",
    tone: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
    desc: "Slope slowing within the same direction.",
  },
  stable: {
    label: "Stable",
    tone: "bg-muted text-muted-foreground border-border",
    desc: "All windows near zero — no meaningful trend.",
  },
  reversing: {
    label: "Reversing",
    tone: "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30",
    desc: "3m slope opposite sign to 12m slope.",
  },
  broken: {
    label: "Broken",
    tone: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
    desc: "Regime shift detected — recent z-score ≥ 2.",
  },
  emerging: {
    label: "Emerging",
    tone: "bg-teal-500/15 text-teal-700 dark:text-teal-400 border-teal-500/30",
    desc: "3m has direction; 12m essentially flat.",
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtPctYr(slope: SlopePack | null): string {
  if (!slope || !Number.isFinite(slope.slopePerYear)) return "—";
  const v = slope.slopePerYear;
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}/yr`;
}

function fmtR2(slope: SlopePack | null): string {
  if (!slope || !Number.isFinite(slope.r2)) return "—";
  return slope.r2.toFixed(2);
}

function r2Tone(r2: number | null | undefined): string {
  if (r2 == null || !Number.isFinite(r2)) return "text-muted-foreground";
  if (r2 >= 0.7) return "text-emerald-600 dark:text-emerald-400";
  if (r2 >= 0.4) return "text-foreground";
  return "text-red-600 dark:text-red-400";
}

function slopeIcon(slope: SlopePack | null) {
  if (!slope || !Number.isFinite(slope.slope) || slope.slope === 0)
    return <Minus className="h-3 w-3 text-muted-foreground" />;
  return slope.slope > 0 ? (
    <ArrowUp className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
  ) : (
    <ArrowDown className="h-3 w-3 text-red-600 dark:text-red-400" />
  );
}

function fmtYm(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 7);
}

// ─── Series picker ───────────────────────────────────────────────────────────

interface RegistryEntry {
  id: string;
  label: string;
  category: string;
  unit?: string;
}

function SeriesPicker({
  selected,
  onChange,
  registry,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  registry: RegistryEntry[];
}) {
  const [open, setOpen] = useState(false);
  const selectedSet = new Set(selected);

  const byId = useMemo(() => {
    const m = new Map<string, RegistryEntry>();
    registry.forEach((r) => m.set(r.id, r));
    return m;
  }, [registry]);

  const remaining = useMemo(
    () => registry.filter((r) => !selectedSet.has(r.id)),
    [registry, selected],
  );

  function remove(id: string) {
    onChange(selected.filter((s) => s !== id));
  }
  function add(id: string) {
    if (!selectedSet.has(id)) onChange([...selected, id]);
    setOpen(false);
  }
  function reset() {
    onChange(DEFAULT_IDS);
  }

  return (
    <Card className="p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold">Series ({selected.length})</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pick the macro drivers and equity indices to analyse. Default = 7 macro + 3 equity.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={reset}
          data-testid="button-reset-series"
          className="h-7 text-xs"
        >
          Reset to default
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5 items-center">
        {selected.map((id) => {
          const entry = byId.get(id);
          return (
            <Badge
              key={id}
              variant="secondary"
              className="gap-1 pl-2 pr-1 py-0.5 text-[11px] font-normal"
              data-testid={`chip-${id}`}
            >
              <span>{entry?.label ?? id}</span>
              <button
                onClick={() => remove(id)}
                className="ml-0.5 rounded-sm hover:bg-foreground/10 p-0.5"
                aria-label={`Remove ${id}`}
                data-testid={`remove-chip-${id}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          );
        })}

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px] gap-1"
              data-testid="button-add-series"
            >
              <Plus className="h-3 w-3" />
              Add series
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-0" align="start">
            <Command>
              <CommandInput placeholder="Search series…" />
              <CommandList>
                <CommandEmpty>No series found.</CommandEmpty>
                {Object.entries(
                  remaining.reduce<Record<string, RegistryEntry[]>>((acc, r) => {
                    (acc[r.category] ??= []).push(r);
                    return acc;
                  }, {}),
                ).map(([cat, entries]) => (
                  <CommandGroup key={cat} heading={cat}>
                    {entries.map((e) => (
                      <CommandItem
                        key={e.id}
                        value={`${e.id} ${e.label}`}
                        onSelect={() => add(e.id)}
                        data-testid={`option-add-${e.id}`}
                      >
                        <span className="truncate">{e.label}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {e.id}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </Card>
  );
}

// ─── Summary cards ───────────────────────────────────────────────────────────

function SummaryStrip({
  results,
  activeFilter,
  onFilterChange,
}: {
  results: TrendResult[];
  activeFilter: Classification | "all";
  onFilterChange: (f: Classification | "all") => void;
}) {
  const counts = useMemo(() => {
    const c: Record<Classification, number> = {
      accelerating: 0,
      decelerating: 0,
      stable: 0,
      reversing: 0,
      broken: 0,
      emerging: 0,
    };
    results.forEach((r) => {
      c[r.classification]++;
    });
    return c;
  }, [results]);

  const cards: Array<{ key: Classification | "all"; label: string; value: number; tone: string }> = [
    { key: "all", label: "All series", value: results.length, tone: "" },
    { key: "broken", label: "Broken", value: counts.broken, tone: "text-red-600 dark:text-red-400" },
    {
      key: "accelerating",
      label: "Accelerating",
      value: counts.accelerating,
      tone: "text-emerald-600 dark:text-emerald-400",
    },
    {
      key: "reversing",
      label: "Reversing",
      value: counts.reversing,
      tone: "text-orange-600 dark:text-orange-400",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      {cards.map((c) => {
        const active = activeFilter === c.key;
        return (
          <Card
            key={c.key}
            onClick={() => onFilterChange(c.key)}
            className={`p-4 cursor-pointer hover-elevate ${
              active ? "ring-2 ring-primary" : ""
            }`}
            data-testid={`summary-${c.key}`}
          >
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {c.label}
            </div>
            <div className={`text-2xl font-semibold mt-1 ${c.tone}`}>{c.value}</div>
          </Card>
        );
      })}
    </div>
  );
}

// ─── Cross-series regime alert ───────────────────────────────────────────────

function RegimeAlert({ results }: { results: TrendResult[] }) {
  const broken = results.filter((r) => r.classification === "broken");
  const accel = results.filter((r) => r.classification === "accelerating");
  if (broken.length >= 3) {
    return (
      <Card className="p-3 mb-4 border-red-500/40 bg-red-500/5">
        <div className="flex items-center gap-2 text-sm">
          <Zap className="h-4 w-4 text-red-600 dark:text-red-400" />
          <span className="font-medium text-red-700 dark:text-red-300">
            Regime shift detected
          </span>
          <span className="text-muted-foreground">
            {broken.length} drivers broken simultaneously
            {broken[0]?.regimeShift?.date
              ? ` since ${fmtYm(broken[0].regimeShift.date)}`
              : ""}
            . Suggests synchronized turning point.
          </span>
        </div>
      </Card>
    );
  }
  if (accel.length >= 3) {
    return (
      <Card className="p-3 mb-4 border-emerald-500/40 bg-emerald-500/5">
        <div className="flex items-center gap-2 text-sm">
          <ArrowUp className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <span className="font-medium text-emerald-700 dark:text-emerald-300">
            Trend pickup
          </span>
          <span className="text-muted-foreground">
            {accel.length} drivers accelerating in concert.
          </span>
        </div>
      </Card>
    );
  }
  return null;
}

// ─── Classification table ────────────────────────────────────────────────────

type SortKey = "label" | "classification" | "s3" | "s6" | "s12" | "r2" | "regime" | "trendStart";

function TrendTable({
  results,
  byId,
  onSelect,
  activeFilter,
}: {
  results: TrendResult[];
  byId: Map<string, RegistryEntry>;
  onSelect: (id: string) => void;
  activeFilter: Classification | "all";
}) {
  const [sortKey, setSortKey] = useState<SortKey>("s12");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const filtered = useMemo(() => {
    if (activeFilter === "all") return results;
    return results.filter((r) => r.classification === activeFilter);
  }, [results, activeFilter]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      let av: number | string = 0;
      let bv: number | string = 0;
      switch (sortKey) {
        case "label":
          av = byId.get(a.id)?.label ?? a.id;
          bv = byId.get(b.id)?.label ?? b.id;
          break;
        case "classification":
          av = a.classification;
          bv = b.classification;
          break;
        case "s3":
          av = a.slopes.s3?.slopePerYear ?? -Infinity;
          bv = b.slopes.s3?.slopePerYear ?? -Infinity;
          break;
        case "s6":
          av = a.slopes.s6?.slopePerYear ?? -Infinity;
          bv = b.slopes.s6?.slopePerYear ?? -Infinity;
          break;
        case "s12":
          av = a.slopes.s12?.slopePerYear ?? -Infinity;
          bv = b.slopes.s12?.slopePerYear ?? -Infinity;
          break;
        case "r2":
          av = a.slopes.s12?.r2 ?? -Infinity;
          bv = b.slopes.s12?.r2 ?? -Infinity;
          break;
        case "regime":
          av = Math.abs(a.regimeShift?.zScore ?? 0);
          bv = Math.abs(b.regimeShift?.zScore ?? 0);
          break;
        case "trendStart":
          av = a.trendStart ?? "";
          bv = b.trendStart ?? "";
          break;
      }
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === "asc"
        ? (av as number) - (bv as number)
        : (bv as number) - (av as number);
    });
    return out;
  }, [filtered, sortKey, sortDir, byId]);

  function toggleSort(k: SortKey) {
    if (k === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  }

  function SortHead({ k, label, className }: { k: SortKey; label: string; className?: string }) {
    return (
      <TableHead className={className}>
        <button
          onClick={() => toggleSort(k)}
          className="flex items-center gap-1 text-[11px] uppercase tracking-wider hover:text-foreground"
          data-testid={`sort-${k}`}
        >
          {label}
          {sortKey === k && (
            <span className="text-[9px]">{sortDir === "asc" ? "▲" : "▼"}</span>
          )}
        </button>
      </TableHead>
    );
  }

  if (sorted.length === 0) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        No series match the current filter.
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <SortHead k="label" label="Series" />
            <SortHead k="classification" label="Classification" />
            <SortHead k="s3" label="3m slope/yr" className="text-right" />
            <SortHead k="s6" label="6m slope/yr" className="text-right" />
            <SortHead k="s12" label="12m slope/yr" className="text-right" />
            <SortHead k="r2" label="12m r²" className="text-right" />
            <SortHead k="regime" label="Regime z" className="text-right" />
            <SortHead k="trendStart" label="Trend start" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((r) => {
            const entry = byId.get(r.id);
            const meta = CLASSIFICATION_META[r.classification];
            const z = r.regimeShift?.zScore ?? 0;
            const zStrong = Math.abs(z) >= 2;
            return (
              <TableRow
                key={r.id}
                onClick={() => onSelect(r.id)}
                className="cursor-pointer"
                data-testid={`row-trend-${r.id}`}
              >
                <TableCell>
                  <div className="font-medium text-sm">{entry?.label ?? r.id}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {entry?.category ?? "—"} · {r.nObs} obs
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={`${meta.tone} text-[10px] font-medium`}
                    title={meta.desc}
                  >
                    {meta.label}
                  </Badge>
                  {r.multiscaleConfirmed && (
                    <span
                      className="ml-1 text-[10px] text-muted-foreground"
                      title="6m and 12m agree on direction"
                    >
                      ✓
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  <span className="inline-flex items-center gap-1 justify-end">
                    {slopeIcon(r.slopes.s3)}
                    {fmtPctYr(r.slopes.s3)}
                  </span>
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  <span className="inline-flex items-center gap-1 justify-end">
                    {slopeIcon(r.slopes.s6)}
                    {fmtPctYr(r.slopes.s6)}
                  </span>
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums font-semibold">
                  <span className="inline-flex items-center gap-1 justify-end">
                    {slopeIcon(r.slopes.s12)}
                    {fmtPctYr(r.slopes.s12)}
                  </span>
                </TableCell>
                <TableCell className={`text-right text-sm tabular-nums ${r2Tone(r.slopes.s12?.r2)}`}>
                  {fmtR2(r.slopes.s12)}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  <span className="inline-flex items-center gap-1 justify-end">
                    {zStrong && <Zap className="h-3 w-3 text-amber-500" />}
                    {Number.isFinite(z) ? (z >= 0 ? "+" : "") + z.toFixed(2) : "—"}
                  </span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {fmtYm(r.trendStart)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Trends() {
  const [selectedIds, setSelectedIds] = useState<string[]>(DEFAULT_IDS);
  const [filter, setFilter] = useState<Classification | "all">("all");
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data: registryData } = useSeriesRegistry();
  const registry: RegistryEntry[] = registryData ?? [];
  const byId = useMemo(() => {
    const m = new Map<string, RegistryEntry>();
    registry.forEach((r) => m.set(r.id, r));
    return m;
  }, [registry]);

  const queryKey = useMemo(
    () => ["/api/trends/detect", [...selectedIds].sort().join(",")],
    [selectedIds],
  );

  const { data, isFetching, error, refetch } = useQuery<TrendsResponse>({
    queryKey,
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/trends/detect", {
        ids: selectedIds,
      });
      return res.json();
    },
    enabled: selectedIds.length > 0,
    staleTime: 60_000,
    retry: 1,
  });

  const results = data?.results ?? [];
  const detailResult = useMemo(
    () => (detailId ? results.find((r) => r.id === detailId) ?? null : null),
    [results, detailId],
  );

  // Context series for AI commentary: select up to 3 other selected series
  // that are most likely macro drivers (registry category != 'equity').
  const contextIds = useMemo(() => {
    if (!detailId) return [] as string[];
    return selectedIds
      .filter((id) => id !== detailId)
      .slice(0, 3);
  }, [detailId, selectedIds]);

  return (
    <div data-testid="page-trends">
      <PageHeader
        title="Trends — multi-timescale slope analysis"
        subtitle="Detects regime shifts and classifies persistence across 3m, 6m, and 12m windows."
        actions={
          <ExportMenu
            resource="trends"
            query={`ids=${encodeURIComponent(selectedIds.join(","))}`}
            disabled={results.length === 0}
          />
        }
        meta={
          <span className="text-[11px] text-muted-foreground">
            Powered by /api/trends/detect — non-LLM, cached 60s.
          </span>
        }
      />

      {detailResult ? (
        <TrendDetail
          result={detailResult}
          registry={byId.get(detailResult.id)}
          onBack={() => setDetailId(null)}
          contextIds={contextIds}
        />
      ) : (
        <>
      <SeriesPicker
        selected={selectedIds}
        onChange={setSelectedIds}
        registry={registry}
      />

      {error ? (
        <Card className="p-4 mb-4 border-red-500/40 bg-red-500/5">
          <div className="text-sm text-red-700 dark:text-red-300">
            Failed to load trends:{" "}
            <span className="font-mono text-xs">{(error as Error).message}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            className="mt-2 h-7 text-xs"
            data-testid="button-retry-trends"
          >
            Retry
          </Button>
        </Card>
      ) : isFetching && results.length === 0 ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      ) : (
        <>
          <RegimeAlert results={results} />
          <SummaryStrip
            results={results}
            activeFilter={filter}
            onFilterChange={setFilter}
          />
          {isFetching && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Re-running detection…
            </div>
          )}
          <TrendTable
            results={results}
            byId={byId}
            onSelect={(id) => setDetailId(id)}
            activeFilter={filter}
          />
          <p className="mt-3 text-[11px] text-muted-foreground">
            Click any row to open the per-series detail view.
          </p>
        </>
      )}
        </>
      )}
    </div>
  );
}
