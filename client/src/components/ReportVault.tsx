/**
 * ReportVault — browsable archive of all saved strategy notes ("past works").
 *
 * The strategy_notes table already persists every generated note; this surfaces
 * them: filter by mode/status, search, reopen, export, rename, mark final, delete.
 * Used on the Report page (and the /vault route) to pick a past note to view.
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ExportMenu } from "@/components/ExportMenu";
import {
  Archive, Search, FileText, Trash2, Pencil, Check, X, FolderOpen, Database, Compass,
} from "lucide-react";

export interface VaultNote {
  id: number;
  title: string;
  asOfDate: string;
  mode: "data_driven" | "thesis_driven";
  createdAt: string;
  status: "draft" | "final";
  costUsd: number;
  userThesis: string;
  emphasis: string[];
  featuredCount: number;
  preview: string;
}

function fmtDate(s: string): string {
  try { return new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return s; }
}

export function ReportVault({ onOpen, activeId }: { onOpen: (id: number) => void; activeId?: number | null }) {
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [modeFilter, setModeFilter] = useState<"all" | "data_driven" | "thesis_driven">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "final">("all");
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");

  const listQuery = useQuery<{ notes: VaultNote[] }, Error>({
    queryKey: ["/api/report"],
    queryFn: async () => (await apiRequest("GET", "/api/report")).json(),
  });

  const renameMutation = useMutation<any, Error, { id: number; title: string }>({
    mutationFn: async ({ id, title }) => (await apiRequest("PUT", `/api/report/${id}`, { title })).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/report"] }); setRenaming(null); toast({ title: "Renamed" }); },
    onError: (e) => toast({ title: "Rename failed", description: e.message, variant: "destructive" }),
  });

  const statusMutation = useMutation<any, Error, { id: number; status: "draft" | "final" }>({
    mutationFn: async ({ id, status }) => (await apiRequest("PUT", `/api/report/${id}`, { status })).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/report"] }); toast({ title: "Status updated" }); },
    onError: (e) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation<any, Error, number>({
    mutationFn: async (id) => (await apiRequest("DELETE", `/api/report/${id}`)).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/report"] }); toast({ title: "Deleted from vault" }); },
    onError: (e) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const notes = listQuery.data?.notes ?? [];
  const filtered = useMemo(() => {
    let rows = notes;
    if (modeFilter !== "all") rows = rows.filter((n) => n.mode === modeFilter);
    if (statusFilter !== "all") rows = rows.filter((n) => n.status === statusFilter);
    if (q.trim()) {
      const needle = q.toLowerCase();
      rows = rows.filter((n) => `${n.title} ${n.userThesis} ${n.preview} ${n.emphasis.join(" ")}`.toLowerCase().includes(needle));
    }
    return rows;
  }, [notes, modeFilter, statusFilter, q]);

  return (
    <Card className="p-5" data-testid="report-vault">
      <div className="mb-3 flex items-center gap-2">
        <Archive className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Report Vault</h3>
        <Badge variant="outline" className="text-[10px]">{notes.length} saved</Badge>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes…" className="h-8 w-56 pl-7 text-sm" />
        </div>
        <div className="flex rounded-md border p-0.5 text-xs">
          {(["all", "data_driven", "thesis_driven"] as const).map((m) => (
            <button key={m} onClick={() => setModeFilter(m)} className={`px-2 py-1 rounded ${modeFilter === m ? "bg-secondary font-medium" : "text-muted-foreground hover:text-foreground"}`}>
              {m === "all" ? "All modes" : m === "data_driven" ? "Data" : "Thesis"}
            </button>
          ))}
        </div>
        <div className="flex rounded-md border p-0.5 text-xs">
          {(["all", "draft", "final"] as const).map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)} className={`px-2 py-1 rounded capitalize ${statusFilter === s ? "bg-secondary font-medium" : "text-muted-foreground hover:text-foreground"}`}>
              {s === "all" ? "All" : s}
            </button>
          ))}
        </div>
      </div>

      {listQuery.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          <FileText className="mx-auto mb-2 h-8 w-8 opacity-50" />
          {notes.length === 0 ? "No saved reports yet. Generate one above to start your archive." : "No reports match these filters."}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((n) => (
            <div key={n.id} className={`rounded-md border p-3 ${activeId === n.id ? "border-primary bg-primary/5" : ""}`} data-testid={`vault-note-${n.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {renaming === n.id ? (
                    <div className="flex items-center gap-1.5">
                      <Input value={renameText} onChange={(e) => setRenameText(e.target.value)} className="h-7 text-sm" autoFocus />
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => renameMutation.mutate({ id: n.id, title: renameText })}><Check className="h-3.5 w-3.5" /></Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setRenaming(null)}><X className="h-3.5 w-3.5" /></Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <button onClick={() => onOpen(n.id)} className="text-left font-medium hover:underline">{n.title}</button>
                      <Badge variant="outline" className={`text-[10px] ${n.mode === "data_driven" ? "bg-blue-500/10 text-blue-700 dark:text-blue-300" : "bg-violet-500/10 text-violet-700 dark:text-violet-300"}`}>
                        {n.mode === "data_driven" ? <Database className="mr-1 h-3 w-3" /> : <Compass className="mr-1 h-3 w-3" />}
                        {n.mode === "data_driven" ? "Data" : "Thesis"}
                      </Badge>
                      <Badge variant={n.status === "final" ? "default" : "outline"} className="text-[10px] capitalize">{n.status}</Badge>
                    </div>
                  )}
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {fmtDate(n.createdAt)} · as of {n.asOfDate}
                    {n.emphasis.length > 0 && <> · {n.emphasis.join(", ")}</>}
                    {n.featuredCount > 0 && <> · {n.featuredCount} names</>}
                  </div>
                  {n.preview && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{n.preview}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => onOpen(n.id)}>
                    <FolderOpen className="h-3.5 w-3.5" /> Open
                  </Button>
                  <ExportMenu resource="report" path={`/api/report/${n.id}/export`} />
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Rename" onClick={() => { setRenaming(n.id); setRenameText(n.title); }}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title={n.status === "final" ? "Mark draft" : "Mark final"} onClick={() => statusMutation.mutate({ id: n.id, status: n.status === "final" ? "draft" : "final" })}>
                    <Check className={`h-3.5 w-3.5 ${n.status === "final" ? "text-emerald-600" : "text-muted-foreground"}`} />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-600 hover:text-red-700" title="Delete" onClick={() => { if (confirm(`Delete "${n.title}" from the vault? This cannot be undone.`)) deleteMutation.mutate(n.id); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
