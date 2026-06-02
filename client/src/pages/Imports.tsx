import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
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
  FileText,
  Eye,
  Save,
  Trash2,
  Download,
  AlertCircle,
  CheckCircle2,
  Copy,
} from "lucide-react";

// ──────────────────────────────────────────────────────────────────────────
// Types matching the /api/imports server contract
// ──────────────────────────────────────────────────────────────────────────
interface ImportedSeriesRow {
  seriesId: string;
  seriesLabel: string;
  sourceName: string;
  sourceMnemonic: string | null;
  unit: string | null;
  frequency: string | null;
  pointCount: number;
  latestDate: string | null;
  latestValue: number | null;
  importedAt: string;
}

interface ParseSample {
  seriesId: string;
  seriesLabel: string;
  date: string;
  value: number;
  sourceMnemonic?: string | null;
  unit?: string | null;
  frequency?: string | null;
}

interface DryRunResult {
  ok: boolean;
  dryRun?: boolean;
  format?: "long" | "wide";
  delimiter?: string;
  seriesIds?: string[];
  rowCount?: number;
  inserted?: { inserted: number; updated: number };
  warnings?: string[];
  sample?: ParseSample[];
  error?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Main page
// ──────────────────────────────────────────────────────────────────────────
export default function Imports() {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [sourceName, setSourceName] = useState<"factset" | "bloomberg" | "manual">("factset");
  const [preview, setPreview] = useState<DryRunResult | null>(null);

  // List of already-imported series
  const { data: listData, isLoading: listLoading } = useQuery<{
    ok: boolean;
    series: ImportedSeriesRow[];
  }>({
    queryKey: ["/api/imports/series"],
  });
  const imported = listData?.series ?? [];

  // Dry-run preview
  const previewMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/imports/factset", {
        text,
        sourceName,
        dryRun: true,
      });
      return (await res.json()) as DryRunResult;
    },
    onSuccess: (d) => {
      setPreview(d);
      if (!d.ok) {
        toast({
          title: "Parse failed",
          description: d.error ?? "Could not parse input",
          variant: "destructive",
        });
      }
    },
    onError: (e: any) => {
      setPreview({ ok: false, error: e.message });
      toast({ title: "Preview failed", description: e.message, variant: "destructive" });
    },
  });

  // Actual import
  const importMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/imports/factset", {
        text,
        sourceName,
        dryRun: false,
      });
      return (await res.json()) as DryRunResult;
    },
    onSuccess: (d) => {
      if (!d.ok) {
        toast({
          title: "Import failed",
          description: d.error ?? "Server rejected the rows",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Imported",
        description: `${d.inserted?.inserted ?? d.rowCount ?? 0} points across ${d.seriesIds?.length ?? 0} series`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/imports/series"] });
      setPreview(d);
    },
    onError: (e: any) => {
      toast({ title: "Import failed", description: e.message, variant: "destructive" });
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (seriesId: string) => {
      const res = await apiRequest("DELETE", `/api/imports/series/${encodeURIComponent(seriesId)}`);
      return res.json();
    },
    onSuccess: (_d, seriesId) => {
      toast({ title: "Deleted", description: `Removed series ${seriesId}` });
      queryClient.invalidateQueries({ queryKey: ["/api/imports/series"] });
    },
    onError: (e: any) =>
      toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  // File picker handler → read as text into the textarea
  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ""));
      setPreview(null);
    };
    reader.onerror = () =>
      toast({ title: "Read failed", description: "Could not read file", variant: "destructive" });
    reader.readAsText(file);
  };

  const sampleRows = preview?.ok ? preview.sample ?? [] : [];
  const seriesIds = preview?.ok ? preview.seriesIds ?? [] : [];

  const previewSummary = useMemo(() => {
    if (!preview) return null;
    if (!preview.ok) return null;
    return `${preview.rowCount} points · ${seriesIds.length} series · ${preview.format} format · delimiter ${JSON.stringify(preview.delimiter ?? "")}`;
  }, [preview, seriesIds.length]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <PageHeader
        title="Imports"
        subtitle="Paste or upload FactSet workstation CSV exports — points are saved to the imported_series table and addressable as imported:<series_id>."
        actions={
          <a
            href="__PORT_5000__/api/imports/template.csv"
            download
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            data-testid="link-template-download"
          >
            <Download className="h-3.5 w-3.5" /> Template CSV
          </a>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        {/* ─── Input column ─── */}
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">1. Provide data</h2>
            <div className="flex items-center gap-2">
              <Label htmlFor="source-select" className="text-xs text-muted-foreground">
                Source
              </Label>
              <Select value={sourceName} onValueChange={(v) => setSourceName(v as any)}>
                <SelectTrigger id="source-select" className="h-7 w-32 text-xs" data-testid="select-source-name">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="factset">FactSet</SelectItem>
                  <SelectItem value="bloomberg">Bloomberg</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mb-3">
            <Label className="text-xs text-muted-foreground">Paste CSV or TSV</Label>
            <Textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setPreview(null);
              }}
              placeholder={"series_id,series_label,date,value,source_mnemonic,unit,frequency\ncn_gdp_yoy,China GDP YoY,2026-03-31,5.0,GDP_CHN_YOY,%,Q\n…"}
              className="mt-1 h-64 font-mono text-[11px]"
              data-testid="input-import-text"
            />
          </div>

          <div className="mb-4 flex items-center gap-2">
            <Label htmlFor="file-picker" className="inline-flex">
              <Button asChild variant="outline" size="sm" data-testid="button-pick-file">
                <span>
                  <Upload className="mr-1.5 h-3.5 w-3.5" /> Upload .csv/.tsv/.txt
                </span>
              </Button>
            </Label>
            <Input
              id="file-picker"
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
              data-testid="input-file"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setText("");
                setPreview(null);
              }}
              data-testid="button-clear-text"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Clear
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!text.trim() || previewMut.isPending}
              onClick={() => previewMut.mutate()}
              data-testid="button-preview"
            >
              <Eye className="mr-1.5 h-3.5 w-3.5" />
              {previewMut.isPending ? "Parsing…" : "Preview"}
            </Button>
            <Button
              size="sm"
              disabled={!text.trim() || importMut.isPending}
              onClick={() => importMut.mutate()}
              data-testid="button-import"
            >
              <Save className="mr-1.5 h-3.5 w-3.5" />
              {importMut.isPending ? "Saving…" : "Import"}
            </Button>
          </div>
        </Card>

        {/* ─── Preview column ─── */}
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">2. Preview</h2>
          {!preview && (
            <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
              <FileText className="mx-auto mb-2 h-5 w-5 opacity-50" />
              Click Preview to dry-run the parser. No data is saved until you click Import.
            </div>
          )}

          {preview && !preview.ok && (
            <Alert variant="destructive" data-testid="alert-parse-error">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                <div className="font-medium">Parse failed</div>
                <div className="mt-1 text-xs">{preview.error}</div>
                {preview.warnings && preview.warnings.length > 0 && (
                  <ul className="mt-2 list-disc pl-4 text-[11px] opacity-80">
                    {preview.warnings.slice(0, 5).map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </AlertDescription>
            </Alert>
          )}

          {preview && preview.ok && (
            <div className="space-y-3">
              <div className="flex items-center gap-2" data-testid="text-preview-summary">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <div className="text-xs">{previewSummary}</div>
              </div>

              <div>
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Discovered series ({seriesIds.length})
                </Label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {seriesIds.map((id) => (
                    <Badge key={id} variant="secondary" className="font-mono text-[10px]">
                      {id}
                    </Badge>
                  ))}
                </div>
              </div>

              <div>
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Sample rows (first 5)
                </Label>
                <div className="mt-1.5 overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="h-8 text-[11px]">Series</TableHead>
                        <TableHead className="h-8 text-[11px]">Date</TableHead>
                        <TableHead className="h-8 text-right text-[11px]">Value</TableHead>
                        <TableHead className="h-8 text-[11px]">Unit</TableHead>
                        <TableHead className="h-8 text-[11px]">Freq</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sampleRows.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="py-1.5 font-mono text-[11px]">
                            {r.seriesId}
                          </TableCell>
                          <TableCell className="py-1.5 text-[11px]">{r.date}</TableCell>
                          <TableCell className="py-1.5 text-right font-mono text-[11px]">
                            {r.value}
                          </TableCell>
                          <TableCell className="py-1.5 text-[11px]">{r.unit ?? "—"}</TableCell>
                          <TableCell className="py-1.5 text-[11px]">{r.frequency ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {preview.warnings && preview.warnings.length > 0 && (
                <div className="rounded-md bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
                  <div className="mb-1 font-medium">{preview.warnings.length} warnings</div>
                  <ul className="list-disc pl-4">
                    {preview.warnings.slice(0, 3).map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                    {preview.warnings.length > 3 && (
                      <li>… +{preview.warnings.length - 3} more</li>
                    )}
                  </ul>
                </div>
              )}

              {preview.inserted && (
                <div className="rounded-md bg-emerald-500/10 p-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                  Saved {preview.inserted.inserted} rows to imported_series. Access them as{" "}
                  <code className="font-mono">imported:&lt;series_id&gt;</code>.
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* ─── Imported series list ─── */}
      <Card className="mt-6 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Imported series</h2>
          <span className="text-[11px] text-muted-foreground">
            {imported.length} series · {imported.reduce((a, b) => a + b.pointCount, 0)} points
          </span>
        </div>

        {listLoading && <div className="text-xs text-muted-foreground">Loading…</div>}

        {!listLoading && imported.length === 0 && (
          <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            No series imported yet. Paste a CSV above to get started.
          </div>
        )}

        {!listLoading && imported.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[11px]">Series ID</TableHead>
                  <TableHead className="text-[11px]">Label</TableHead>
                  <TableHead className="text-[11px]">Source</TableHead>
                  <TableHead className="text-[11px]">Mnemonic</TableHead>
                  <TableHead className="text-[11px]">Unit</TableHead>
                  <TableHead className="text-[11px]">Freq</TableHead>
                  <TableHead className="text-right text-[11px]">Points</TableHead>
                  <TableHead className="text-[11px]">Latest</TableHead>
                  <TableHead className="text-right text-[11px]">Latest val</TableHead>
                  <TableHead className="text-[11px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {imported.map((s) => {
                  const logical = `imported:${s.seriesId}`;
                  return (
                    <TableRow key={s.seriesId} data-testid={`row-imported-${s.seriesId}`}>
                      <TableCell className="font-mono text-[11px]">{s.seriesId}</TableCell>
                      <TableCell className="text-[11px]">{s.seriesLabel}</TableCell>
                      <TableCell className="text-[11px]">
                        <Badge variant="outline" className="text-[10px]">
                          {s.sourceName}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-[10px] text-muted-foreground">
                        {s.sourceMnemonic ?? "—"}
                      </TableCell>
                      <TableCell className="text-[11px]">{s.unit ?? "—"}</TableCell>
                      <TableCell className="text-[11px]">{s.frequency ?? "—"}</TableCell>
                      <TableCell className="text-right font-mono text-[11px]">
                        {s.pointCount}
                      </TableCell>
                      <TableCell className="text-[11px]">{s.latestDate ?? "—"}</TableCell>
                      <TableCell className="text-right font-mono text-[11px]">
                        {s.latestValue != null ? Number(s.latestValue).toLocaleString() : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title={`Copy logical id: ${logical}`}
                            onClick={() => {
                              navigator.clipboard.writeText(logical);
                              toast({ title: "Copied", description: logical });
                            }}
                            data-testid={`button-copy-${s.seriesId}`}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive"
                            title="Delete series"
                            onClick={() => {
                              if (
                                confirm(
                                  `Delete all ${s.pointCount} points for ${s.seriesId}? This cannot be undone.`,
                                )
                              ) {
                                deleteMut.mutate(s.seriesId);
                              }
                            }}
                            data-testid={`button-delete-${s.seriesId}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
