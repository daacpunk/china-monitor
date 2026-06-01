import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import { Download, Receipt } from "lucide-react";

interface Summary {
  yearMonth: string;
  byService: Array<{ service: string; total: number; calls: number }>;
  byContext: Array<{ actionContext: string | null; service: string; total: number; calls: number }>;
  ceilings: any[];
  forecast: Array<{ service: string; mtdSpend: number; mtdCalls: number; projectedSpend: number }>;
}

export default function Audit() {
  const [filterService, setFilterService] = useState<string>("all");
  const { data: summary } = useQuery<Summary>({ queryKey: ["/api/audit/summary"] });
  const { data: log = [] } = useQuery<any[]>({
    queryKey: ["/api/audit/log", filterService],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filterService !== "all") params.set("service", filterService);
      params.set("limit", "500");
      const r = await apiRequest("GET", `/api/audit/log?${params.toString()}`);
      return r.json();
    },
  });

  const services = ["ceic", "sonar", "anthropic", "deepseek"];

  return (
    <div data-testid="page-audit">
      <PageHeader
        title="Audit trail"
        subtitle="Every paid API call is logged here. Per-feature attribution and end-of-month spend forecast included."
        actions={
          <Button asChild variant="outline" data-testid="button-export-csv">
            <a href="/api/audit/log.csv" download>
              <Download className="h-4 w-4 mr-1.5" />Export CSV
            </a>
          </Button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {services.map((svc) => {
          const s = summary?.byService.find((x) => x.service === svc);
          const c = summary?.ceilings.find((x: any) => x.service === svc);
          const f = summary?.forecast.find((x) => x.service === svc);
          const spend = s?.total ?? 0;
          const limit = c?.monthlyLimitUsd ?? 0;
          const pct = limit > 0 ? Math.min(100, (spend / limit) * 100) : 0;
          return (
            <Card key={svc} className="p-3" data-testid={`audit-card-${svc}`}>
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs font-semibold capitalize">{svc}</div>
                <Badge variant="outline" className="font-normal text-[10px]">{s?.calls ?? 0} calls</Badge>
              </div>
              <div className="text-lg font-semibold tabular-nums">${spend.toFixed(2)}</div>
              <div className="text-[11px] text-muted-foreground">of ${limit.toFixed(2)} cap</div>
              <div className="h-1 bg-muted rounded-full mt-2 overflow-hidden">
                <div
                  className={`h-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {f && f.projectedSpend > 0 && (
                <div className={`text-[10px] mt-2 ${f.projectedSpend > limit ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
                  Forecast EOM: ${f.projectedSpend.toFixed(2)}
                  {f.projectedSpend > limit && " ⚠ over cap"}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-3">Per-feature attribution ({summary?.yearMonth ?? "—"})</h3>
          {(summary?.byContext ?? []).length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              No paid calls yet this month. Wire CEIC / Sonar / Claude / DeepSeek in Phase 2-3.
            </div>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Feature</TableHead><TableHead>Service</TableHead><TableHead className="text-right">Calls</TableHead><TableHead className="text-right">$</TableHead></TableRow></TableHeader>
              <TableBody>
                {summary!.byContext.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs">{r.actionContext ?? "(uncategorized)"}</TableCell>
                    <TableCell className="text-xs capitalize">{r.service}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{r.calls}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">${r.total.toFixed(3)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-3">End-of-month spend forecast</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Linear extrapolation of MTD spend ÷ days elapsed × days in month. Conservative for
            services with weekly batch usage; aggressive for services with one-off heavy days.
          </p>
          <Table>
            <TableHeader><TableRow><TableHead>Service</TableHead><TableHead className="text-right">MTD</TableHead><TableHead className="text-right">Projected</TableHead></TableRow></TableHeader>
            <TableBody>
              {(summary?.forecast ?? []).map((f) => {
                const c = summary?.ceilings.find((x: any) => x.service === f.service);
                const over = c && f.projectedSpend > c.monthlyLimitUsd;
                return (
                  <TableRow key={f.service}>
                    <TableCell className="text-xs capitalize">{f.service}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">${f.mtdSpend.toFixed(2)}</TableCell>
                    <TableCell className={`text-right text-xs tabular-nums ${over ? "text-red-600 dark:text-red-400 font-semibold" : ""}`}>
                      ${f.projectedSpend.toFixed(2)}{over ? " ⚠" : ""}
                    </TableCell>
                  </TableRow>
                );
              })}
              {(summary?.forecast ?? []).length === 0 && (
                <TableRow><TableCell colSpan={3} className="text-center text-xs text-muted-foreground py-6">No data yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Recent call log</h3>
          <Select value={filterService} onValueChange={setFilterService}>
            <SelectTrigger className="w-40 h-8 text-xs" data-testid="select-filter-service">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All services</SelectItem>
              <SelectItem value="ceic">CEIC</SelectItem>
              <SelectItem value="sonar">Sonar</SelectItem>
              <SelectItem value="anthropic">Anthropic</SelectItem>
              <SelectItem value="deepseek">DeepSeek</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {log.length === 0 ? (
          <div className="py-12 text-center">
            <Receipt className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
            <div className="text-sm text-muted-foreground">No calls logged yet</div>
            <div className="text-xs text-muted-foreground mt-1">Live API integrations ship in Phase 2-3</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Time</TableHead>
                  <TableHead className="text-xs">Service</TableHead>
                  <TableHead className="text-xs">Endpoint</TableHead>
                  <TableHead className="text-xs">Feature</TableHead>
                  <TableHead className="text-xs">Model</TableHead>
                  <TableHead className="text-xs text-right">Tok in/out</TableHead>
                  <TableHead className="text-xs text-right">$</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="text-xs text-right">ms</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {log.map((r: any) => (
                  <TableRow key={r.id} data-testid={`audit-row-${r.id}`}>
                    <TableCell className="text-[11px] tabular-nums">{new Date(r.ts).toLocaleString()}</TableCell>
                    <TableCell className="text-[11px] capitalize">{r.service}</TableCell>
                    <TableCell className="text-[11px] font-mono">{r.endpoint}</TableCell>
                    <TableCell className="text-[11px]">{r.actionContext ?? "—"}</TableCell>
                    <TableCell className="text-[11px]">{r.model ?? "—"}</TableCell>
                    <TableCell className="text-[11px] tabular-nums text-right">{r.tokensIn}/{r.tokensOut}</TableCell>
                    <TableCell className="text-[11px] tabular-nums text-right">${r.costUsd.toFixed(4)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={r.status === "ok" ? "outline" : "destructive"}
                        className={`font-normal text-[10px] ${r.status === "blocked_by_ceiling" ? "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/40" : ""}`}
                      >
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-[11px] tabular-nums text-right">{r.latencyMs ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
