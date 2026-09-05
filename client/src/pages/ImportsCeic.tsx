/**
 * CEIC import panel (Phase 7) — rendered as the "CEIC (CDMNext)" tab of the
 * Imports page.
 *
 * Three jobs:
 *   1. Show the live CEIC source mode (api | python_bridge | cdm_import |
 *      unavailable) so the user always knows how CEIC data is arriving.
 *   2. Preview + commit a CDMNext export (paste, .csv/.tsv, or .xlsx).
 *   3. Manage the catalog: map a CEIC series to a China Monitor logical ID and
 *      inspect the revision (vintage) trail.
 *
 * There is deliberately NO password field here. CEIC website credentials belong
 * only in ceic-python-bridge/.env on the user's own machine.
 */

import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  Eye,
  Save,
  Download,
  AlertCircle,
  CheckCircle2,
  History,
  Link2,
  RefreshCw,
  FileSpreadsheet,
} from "lucide-react";

// ── Contract types ─────────────────────────────────────────────────────────

interface CeicStatus {
  mode: "api" | "python_bridge" | "cdm_import" | "unavailable";
  overrideMode: string;
  apiKeyConfigured: boolean;
  apiUsable: boolean;
  bridgeTokenConfigured: boolean;
  catalogCount: number;
  mappedCount: number;
  observationCount: number;
  vintageCount: number;
  seriesWithVintages: number;
  latestObservationDate: string | null;
  latestVintageDate: string | null;
  latestImportAt: string | null;
  staleSeries: { seriesId: string; logicalId: string; lastDate: string | null; ageDays: number | null }[];
  freshSeriesCount: number;
  lastError: string | null;
  summary: string;
  recentFiles?: {
    fileHash: string; filename: string | null; sourceMode: string;
    vintageDate: string; layout: string | null; seriesCount: number;
    rowCount: number; importedAt: string | null;
  }[];
}

interface CatalogEntry {
  seriesId: string;
  mnemonic: string | null;
  label: string;
  geo: string | null;
  frequency: string | null;
  unit: string | null;
  originalSource: string | null;
  logicalId: string | null;
  transform: string | null;
  firstDate: string | null;
  lastDate: string | null;
  lastImportedAt: string | null;
  lastFileVintage: string | null;
  status: string;
  sourceMode: string;
}

interface CatalogResponse {
  ok: boolean;
  count: number;
  mapped: number;
  catalog: CatalogEntry[];
  logicalIds: { id: string; label: string; unit: string; category: string }[];
  transforms: string[];
}

interface SeriesMeta {
  seriesId: string;
  label: string;
  unit: string | null;
  frequency: string | null;
  geo: string | null;
  originalSource: string | null;
  firstDate: string | null;
  lastDate: string | null;
  pointCount: number;
  valueCount: number;
}

interface PreviewResult {
  ok: boolean;
  error?: string;
  layout?: "long" | "wide" | "two_column";
  delimiter?: string | null;
  rowCount?: number;
  seriesCount?: number;
  series?: SeriesMeta[];
  sample?: { seriesId: string; observationDate: string; value: number | null }[];
  warnings?: string[];
  warningCount?: number;
  fileHash?: string;
  sheetName?: string | null;
  duplicate?: boolean;
  duplicateOf?: { importedAt: string; vintageDate: string; rowCount: number } | null;
  vintageDate?: string;
  commit?: {
    duplicate: boolean;
    vintageDate: string;
    catalogUpserted: number;
    vintageRows: number;
    currentRows: number;
    seriesCount: number;
    mappedSeries: { seriesId: string; logicalId: string }[];
    revisions: { seriesId: string; observationDate: string; previous: number | null; current: number | null }[];
  };
}

const MODE_COPY: Record<CeicStatus["mode"], { label: string; cls: string; blurb: string }> = {
  api: {
    label: "REST API",
    cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    blurb: "An entitled CEIC API key is configured — mapped series are pulled server-side.",
  },
  python_bridge: {
    label: "Python bridge",
    cls: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
    blurb: "Data is arriving from the local collector in ceic-python-bridge/ using your CEIC website login.",
  },
  cdm_import: {
    label: "CDM import",
    cls: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
    blurb: "Data is arriving from CDMNext Excel/CSV exports uploaded here.",
  },
  unavailable: {
    label: "Not connected",
    cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    blurb:
      "No CEIC data yet. The API key (if any) has no data entitlement — upload a CDMNext export below, or run the local Python bridge.",
  },
};

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  return s.slice(0, 10);
}

export default function ImportsCeic() {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [fileBase64, setFileBase64] = useState<string | null>(null);
  const [filename, setFilename] = useState<string>("");
  const [vintageDate, setVintageDate] = useState<string>("");
  const [dateFormat, setDateFormat] = useState<"auto" | "mdy" | "dmy">("auto");
  const [defSeriesId, setDefSeriesId] = useState("");
  const [defLabel, setDefLabel] = useState("");
  const [defUnit, setDefUnit] = useState("");
  const [defFrequency, setDefFrequency] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [vintageFor, setVintageFor] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: status, refetch: refetchStatus } = useQuery<CeicStatus>({
    queryKey: ["/api/ceic/status"],
    queryFn: async () => (await apiRequest("GET", "/api/ceic/status")).json(),
    refetchInterval: 120_000,
  });

  const { data: catalogData, isLoading: catalogLoading } = useQuery<CatalogResponse>({
    queryKey: ["/api/ceic/catalog"],
    queryFn: async () => (await apiRequest("GET", "/api/ceic/catalog")).json(),
  });
  const catalog = catalogData?.catalog ?? [];

  const { data: vintages } = useQuery<any>({
    queryKey: ["/api/ceic/vintages", vintageFor],
    enabled: !!vintageFor,
    queryFn: async () =>
      (await apiRequest("GET", `/api/ceic/catalog/${encodeURIComponent(vintageFor!)}/vintages`)).json(),
  });

  function body(dryRun: boolean) {
    const defaults: Record<string, string> = {};
    if (defSeriesId.trim()) defaults.seriesId = defSeriesId.trim();
    if (defLabel.trim()) defaults.label = defLabel.trim();
    if (defUnit.trim()) defaults.unit = defUnit.trim();
    if (defFrequency.trim()) defaults.frequency = defFrequency.trim();
    return {
      ...(fileBase64 ? { fileBase64, filename } : { text }),
      dryRun,
      dateFormat,
      ...(vintageDate ? { vintageDate } : {}),
      ...(Object.keys(defaults).length ? { defaults } : {}),
    };
  }

  const previewMut = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/imports/ceic", body(true))).json() as Promise<PreviewResult>,
    onSuccess: (d) => {
      setPreview(d);
      if (!d.ok) toast({ title: "Parse failed", description: d.error, variant: "destructive" });
      else if (d.duplicate)
        toast({
          title: "Already imported",
          description: `This exact file was imported on ${fmtDate(d.duplicateOf?.importedAt)} — committing it again is a no-op.`,
        });
    },
    onError: (e: any) => {
      setPreview({ ok: false, error: e.message });
      toast({ title: "Preview failed", description: e.message, variant: "destructive" });
    },
  });

  const commitMut = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/imports/ceic", body(false))).json() as Promise<PreviewResult>,
    onSuccess: (d) => {
      setPreview(d);
      if (!d.ok) {
        toast({ title: "Import failed", description: d.error, variant: "destructive" });
        return;
      }
      const c = d.commit;
      toast({
        title: c?.duplicate ? "Already imported (no-op)" : "CEIC import committed",
        description: c?.duplicate
          ? "Identical file hash — nothing was written."
          : `${c?.vintageRows ?? 0} vintage rows · ${c?.currentRows ?? 0} current values · ${c?.seriesCount ?? 0} series` +
            (c?.revisions?.length ? ` · ${c.revisions.length} revisions detected` : ""),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/ceic/catalog"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ceic/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/imports/series"] });
    },
    onError: (e: any) => toast({ title: "Import failed", description: e.message, variant: "destructive" }),
  });

  const mapMut = useMutation({
    mutationFn: async (v: { seriesId: string; logicalId: string | null; transform: string | null }) =>
      (
        await apiRequest("POST", `/api/ceic/catalog/${encodeURIComponent(v.seriesId)}/mapping`, {
          logicalId: v.logicalId,
          transform: v.transform,
        })
      ).json(),
    onSuccess: (d: any) => {
      if (!d.ok) {
        toast({ title: "Mapping rejected", description: d.error, variant: "destructive" });
        return;
      }
      toast({
        title: "Mapping saved",
        description: d.entry?.logicalId
          ? `${d.entry.seriesId} → ${d.entry.logicalId}. It now feeds the dashboards, report, and deck.`
          : `${d.entry?.seriesId} unmapped (catalog only).`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/ceic/catalog"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ceic/status"] });
    },
    onError: (e: any) => toast({ title: "Mapping failed", description: e.message, variant: "destructive" }),
  });

  function handleFile(file: File) {
    setFilename(file.name);
    const isSheet = /\.(xlsx|xlsm|xls)$/i.test(file.name);
    const reader = new FileReader();
    reader.onerror = () =>
      toast({ title: "Read failed", description: "Could not read file", variant: "destructive" });
    if (isSheet) {
      reader.onload = () => {
        // FileReader gives "data:...;base64,XXXX" — keep only the payload.
        const s = String(reader.result ?? "");
        setFileBase64(s.slice(s.indexOf(",") + 1));
        setText("");
        setPreview(null);
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => {
        setText(String(reader.result ?? ""));
        setFileBase64(null);
        setPreview(null);
      };
      reader.readAsText(file);
    }
  }

  const hasInput = !!text.trim() || !!fileBase64;
  const mode = status?.mode ?? "unavailable";
  const modeCopy = MODE_COPY[mode];

  const summaryLine = useMemo(() => {
    if (!preview?.ok) return null;
    return (
      `${preview.rowCount} observations · ${preview.seriesCount} series · ${preview.layout} layout` +
      (preview.sheetName ? ` · sheet "${preview.sheetName}"` : "") +
      (preview.warningCount ? ` · ${preview.warningCount} warnings` : "")
    );
  }, [preview]);

  return (
    <div className="space-y-6">
      {/* ─── Source mode ─── */}
      <Card className="p-5" data-testid="card-ceic-mode">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">CEIC source mode</h2>
          <Badge variant="secondary" className={`font-normal ${modeCopy.cls}`} data-testid="badge-ceic-mode">
            {modeCopy.label}
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-7 w-7"
            title="Refresh status"
            onClick={() => refetchStatus()}
            data-testid="button-refresh-ceic-status"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">{modeCopy.blurb}</p>
        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 lg:grid-cols-6">
          {[
            ["Catalog series", status?.catalogCount ?? 0],
            ["Mapped to logical IDs", status?.mappedCount ?? 0],
            ["Observations", status?.observationCount ?? 0],
            ["Vintage rows", status?.vintageCount ?? 0],
            ["Series with revisions", status?.seriesWithVintages ?? 0],
            ["Stale mapped series", status?.staleSeries?.length ?? 0],
          ].map(([k, v]) => (
            <div key={String(k)}>
              <div className="text-muted-foreground">{k}</div>
              <div className="font-mono text-sm font-semibold">{String(v)}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>Latest observation: {fmtDate(status?.latestObservationDate)}</span>
          <span>Latest import: {fmtDate(status?.latestImportAt)}</span>
          <span>Latest vintage: {fmtDate(status?.latestVintageDate)}</span>
          <span>
            Bridge token: {status?.bridgeTokenConfigured ? "configured" : "not set (bridge endpoint disabled)"}
          </span>
          <span>API key: {status?.apiKeyConfigured ? (status.apiUsable ? "entitled" : "present, not entitled") : "none"}</span>
        </div>
        {!!status?.staleSeries?.length && (
          <Alert className="mt-3" data-testid="alert-ceic-stale">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <span className="font-medium">{status.staleSeries.length} mapped CEIC series are stale.</span>{" "}
              They are not overriding fresher free sources — the report falls back to
              AKShare/FRED/NBS/OECD and adds a data-quality note. Refresh the CDMNext export
              or re-run the collector.
              <div className="mt-1 font-mono text-[10px] opacity-80">
                {status.staleSeries.slice(0, 6).map((s) => (
                  <div key={s.seriesId}>
                    {s.logicalId} ← {s.seriesId} · last {fmtDate(s.lastDate)}
                    {s.ageDays != null ? ` (${s.ageDays}d)` : ""}
                  </div>
                ))}
              </div>
            </AlertDescription>
          </Alert>
        )}
        {status?.lastError && (
          <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">Last error: {status.lastError}</div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        {/* ─── Upload ─── */}
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">1. CDMNext export</h2>
            <div className="flex gap-2 text-[11px]">
              <a
                href="__PORT_5000__/api/imports/ceic-template.csv?layout=long"
                download
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                data-testid="link-ceic-template-long"
              >
                <Download className="h-3 w-3" /> long
              </a>
              <a
                href="__PORT_5000__/api/imports/ceic-template.csv?layout=wide"
                download
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                data-testid="link-ceic-template-wide"
              >
                <Download className="h-3 w-3" /> wide
              </a>
            </div>
          </div>

          <p className="mb-3 text-[11px] text-muted-foreground">
            In CDMNext, select your series → <em>Export</em> → Excel or CSV (up to 3,000 series
            per export). Long, wide, and plain two-column layouts are all detected
            automatically; blanks are preserved as missing observations rather than dropped.
          </p>

          <Textarea
            value={fileBase64 ? `(${filename} loaded as spreadsheet — ${Math.round((fileBase64.length * 3) / 4 / 1024)} KB)` : text}
            disabled={!!fileBase64}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
            placeholder={"Series ID,123456,123457\nName,Total Social Financing,DR007\nFrequency,Monthly,Daily\nUnit,RMB bn,% pa\nDate,,\n2026-06,431500,1.68\n…"}
            className="h-48 font-mono text-[11px]"
            data-testid="input-ceic-text"
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              data-testid="button-ceic-pick-file"
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" /> Upload .xlsx / .csv / .tsv
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xlsm,.xls,.csv,.tsv,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
              data-testid="input-ceic-file"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setText("");
                setFileBase64(null);
                setFilename("");
                setPreview(null);
              }}
              data-testid="button-ceic-clear"
            >
              Clear
            </Button>
            {filename && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <FileSpreadsheet className="h-3 w-3" /> {filename}
              </span>
            )}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[11px] text-muted-foreground">Vintage date (defaults to today)</Label>
              <Input
                type="date"
                value={vintageDate}
                onChange={(e) => setVintageDate(e.target.value)}
                className="mt-1 h-8 text-xs"
                data-testid="input-ceic-vintage"
              />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">Ambiguous slash dates</Label>
              <Select value={dateFormat} onValueChange={(v) => setDateFormat(v as any)}>
                <SelectTrigger className="mt-1 h-8 text-xs" data-testid="select-ceic-dateformat">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto-detect</SelectItem>
                  <SelectItem value="dmy">DD/MM/YYYY</SelectItem>
                  <SelectItem value="mdy">MM/DD/YYYY</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mt-4 rounded-md border border-dashed p-3">
            <div className="mb-2 text-[11px] font-medium">
              Two-column export? CEIC omits the series identity — supply it here.
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="CEIC series ID"
                value={defSeriesId}
                onChange={(e) => setDefSeriesId(e.target.value)}
                className="h-8 text-xs"
                data-testid="input-ceic-def-seriesid"
              />
              <Input
                placeholder="Label"
                value={defLabel}
                onChange={(e) => setDefLabel(e.target.value)}
                className="h-8 text-xs"
                data-testid="input-ceic-def-label"
              />
              <Input
                placeholder="Unit (e.g. RMB bn)"
                value={defUnit}
                onChange={(e) => setDefUnit(e.target.value)}
                className="h-8 text-xs"
                data-testid="input-ceic-def-unit"
              />
              <Input
                placeholder="Frequency (Monthly/Daily/…)"
                value={defFrequency}
                onChange={(e) => setDefFrequency(e.target.value)}
                className="h-8 text-xs"
                data-testid="input-ceic-def-frequency"
              />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!hasInput || previewMut.isPending}
              onClick={() => previewMut.mutate()}
              data-testid="button-ceic-preview"
            >
              <Eye className="mr-1.5 h-3.5 w-3.5" />
              {previewMut.isPending ? "Parsing…" : "Preview"}
            </Button>
            <Button
              size="sm"
              disabled={!hasInput || commitMut.isPending}
              onClick={() => commitMut.mutate()}
              data-testid="button-ceic-commit"
            >
              <Save className="mr-1.5 h-3.5 w-3.5" />
              {commitMut.isPending ? "Saving…" : "Import"}
            </Button>
          </div>
        </Card>

        {/* ─── Preview ─── */}
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold">2. Preview</h2>
          {!preview && (
            <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
              Preview dry-runs the parser and reports the detected layout, series metadata,
              and any warnings. Nothing is written until you click Import.
            </div>
          )}

          {preview && !preview.ok && (
            <Alert variant="destructive" data-testid="alert-ceic-parse-error">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                <div className="font-medium">Parse failed</div>
                <div className="mt-1 text-xs">{preview.error}</div>
              </AlertDescription>
            </Alert>
          )}

          {preview?.ok && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs" data-testid="text-ceic-preview-summary">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                {summaryLine}
              </div>
              {preview.duplicate && (
                <div className="rounded-md bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
                  Identical file already imported ({fmtDate(preview.duplicateOf?.importedAt)}, vintage{" "}
                  {preview.duplicateOf?.vintageDate}). Importing again is a safe no-op.
                </div>
              )}
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="h-8 text-[11px]">Series</TableHead>
                      <TableHead className="h-8 text-[11px]">Label</TableHead>
                      <TableHead className="h-8 text-[11px]">Freq</TableHead>
                      <TableHead className="h-8 text-[11px]">Unit</TableHead>
                      <TableHead className="h-8 text-[11px]">Range</TableHead>
                      <TableHead className="h-8 text-right text-[11px]">Obs</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(preview.series ?? []).slice(0, 25).map((s) => (
                      <TableRow key={s.seriesId}>
                        <TableCell className="py-1.5 font-mono text-[11px]">{s.seriesId}</TableCell>
                        <TableCell className="py-1.5 text-[11px]">{s.label}</TableCell>
                        <TableCell className="py-1.5 text-[11px]">{s.frequency ?? "—"}</TableCell>
                        <TableCell className="py-1.5 text-[11px]">{s.unit ?? "—"}</TableCell>
                        <TableCell className="py-1.5 text-[11px]">
                          {fmtDate(s.firstDate)} → {fmtDate(s.lastDate)}
                        </TableCell>
                        <TableCell className="py-1.5 text-right font-mono text-[11px]">
                          {s.valueCount}/{s.pointCount}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {!!preview.warnings?.length && (
                <div className="rounded-md bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
                  <div className="mb-1 font-medium">{preview.warningCount} warnings</div>
                  <ul className="list-disc pl-4">
                    {preview.warnings.slice(0, 4).map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.commit && !preview.commit.duplicate && (
                <div className="rounded-md bg-emerald-500/10 p-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                  Committed vintage {preview.commit.vintageDate}: {preview.commit.vintageRows} vintage rows,{" "}
                  {preview.commit.currentRows} current values, {preview.commit.catalogUpserted} catalog entries
                  {preview.commit.revisions.length > 0 && (
                    <>
                      {" · "}
                      <span className="font-medium">{preview.commit.revisions.length} revisions</span> vs the
                      previous vintage
                    </>
                  )}
                  .
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* ─── Catalog + mapping ─── */}
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">3. Catalog &amp; logical-ID mapping</h2>
          <span className="text-[11px] text-muted-foreground">
            {catalogData?.count ?? 0} series · {catalogData?.mapped ?? 0} mapped
          </span>
        </div>

        {catalogLoading && <div className="text-xs text-muted-foreground">Loading…</div>}

        {!catalogLoading && catalog.length === 0 && (
          <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            <Link2 className="mx-auto mb-2 h-5 w-5 opacity-50" />
            CEIC catalog is empty. Import a CDMNext export above, or run the local Python
            bridge, and every series will appear here ready to map onto a China Monitor
            logical ID.
          </div>
        )}

        {!catalogLoading && catalog.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[11px]">CEIC ID</TableHead>
                  <TableHead className="text-[11px]">Label</TableHead>
                  <TableHead className="text-[11px]">Freq</TableHead>
                  <TableHead className="text-[11px]">Unit</TableHead>
                  <TableHead className="text-[11px]">Last obs</TableHead>
                  <TableHead className="text-[11px]">Via</TableHead>
                  <TableHead className="text-[11px]">Logical ID</TableHead>
                  <TableHead className="text-[11px]">Transform</TableHead>
                  <TableHead className="text-[11px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalog.map((c) => (
                  <TableRow key={c.seriesId} data-testid={`row-ceic-${c.seriesId}`}>
                    <TableCell className="font-mono text-[11px]">{c.seriesId}</TableCell>
                    <TableCell className="max-w-[220px] truncate text-[11px]" title={c.label}>
                      {c.label}
                    </TableCell>
                    <TableCell className="text-[11px]">{c.frequency ?? "—"}</TableCell>
                    <TableCell className="text-[11px]">{c.unit ?? "—"}</TableCell>
                    <TableCell className="text-[11px]">{fmtDate(c.lastDate)}</TableCell>
                    <TableCell className="text-[11px]">
                      <Badge variant="outline" className="text-[10px]">
                        {c.sourceMode === "python_bridge" ? "bridge" : c.sourceMode === "api" ? "api" : "CDM"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={c.logicalId ?? "__none__"}
                        onValueChange={(v) =>
                          mapMut.mutate({
                            seriesId: c.seriesId,
                            logicalId: v === "__none__" ? null : v,
                            transform: c.transform,
                          })
                        }
                      >
                        <SelectTrigger className="h-7 w-44 text-[11px]" data-testid={`select-map-${c.seriesId}`}>
                          <SelectValue placeholder="unmapped" />
                        </SelectTrigger>
                        <SelectContent className="max-h-72">
                          <SelectItem value="__none__">— unmapped —</SelectItem>
                          {(catalogData?.logicalIds ?? []).map((l) => (
                            <SelectItem key={l.id} value={l.id}>
                              {l.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={c.transform ?? "raw"}
                        onValueChange={(v) =>
                          mapMut.mutate({
                            seriesId: c.seriesId,
                            logicalId: c.logicalId,
                            transform: v === "raw" ? "raw" : v,
                          })
                        }
                      >
                        <SelectTrigger className="h-7 w-32 text-[11px]" data-testid={`select-transform-${c.seriesId}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(catalogData?.transforms ?? ["raw"]).map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Inspect revision history"
                        onClick={() => setVintageFor(vintageFor === c.seriesId ? null : c.seriesId)}
                        data-testid={`button-vintages-${c.seriesId}`}
                      >
                        <History className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {vintageFor && vintages?.ok && (
          <div className="mt-4 rounded-md border p-3" data-testid="panel-ceic-vintages">
            <div className="mb-2 text-xs font-medium">
              Revision trail — {vintageFor}{" "}
              <span className="font-normal text-muted-foreground">
                ({vintages.revisedObservations} observation(s) revised across vintages)
              </span>
            </div>
            <div className="max-h-64 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-7 text-[11px]">Observation</TableHead>
                    <TableHead className="h-7 text-[11px]">Vintages (newest first)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(vintages.observations ?? []).slice(0, 40).map((o: any) => (
                    <TableRow key={o.observationDate}>
                      <TableCell className="py-1 font-mono text-[11px]">{o.observationDate}</TableCell>
                      <TableCell className="py-1 font-mono text-[11px]">
                        {o.vintages
                          .map((v: any) => `${v.vintageDate}: ${v.value ?? "—"}`)
                          .join("  ←  ")}
                        {o.vintages.length > 1 && (
                          <Badge variant="secondary" className="ml-2 text-[10px]">
                            revised
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </Card>

      {/* ─── Python bridge instructions ─── */}
      <Card className="p-5">
        <h2 className="mb-2 text-sm font-semibold">4. Local Python bridge (optional)</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          If CEIC has enabled Python access for your login, the collector in{" "}
          <code className="font-mono">ceic-python-bridge/</code> can refresh mapped series
          automatically. It runs on <strong>your machine</strong> — your CEIC username and
          password never enter this web app, this server, or Railway. There is deliberately
          no password field anywhere in this UI.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li>
            <code className="font-mono">
              pip install --extra-index-url https://downloads.ceicdata.com/python ceic_api_client
            </code>
          </li>
          <li>
            <code className="font-mono">cp .env.example .env</code> and set{" "}
            <code className="font-mono">CEIC_LOGIN</code> / <code className="font-mono">CEIC_PASSWORD</code>.
          </li>
          <li>
            <code className="font-mono">python3 probe.py</code> — prints a redacted diagnostic
            telling you whether your subscription supports this route at all.
          </li>
          <li>
            Set <code className="font-mono">CEIC_IMPORT_TOKEN</code> to the same random value on
            Railway and in the bridge&apos;s <code className="font-mono">.env</code>, then run{" "}
            <code className="font-mono">python3 collector.py --post</code>.
          </li>
        </ol>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Bridge endpoint status:{" "}
          {status?.bridgeTokenConfigured ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              enabled (CEIC_IMPORT_TOKEN configured)
            </span>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">
              disabled — set CEIC_IMPORT_TOKEN on the server to enable POST /api/imports/ceic-bridge
            </span>
          )}
        </p>
      </Card>
    </div>
  );
}
