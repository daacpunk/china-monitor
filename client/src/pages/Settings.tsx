import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useTheme } from "@/lib/theme";
import { CheckCircle2, AlertCircle, ExternalLink } from "lucide-react";

const SERVICES = [
  { id: "ceic",     name: "CEIC",            docs: "https://developer.isimarkets.com/", hint: "Set in CDMNext > User > API. Header: `Authorization: Bearer …`" },
  { id: "sonar",    name: "Perplexity Sonar Pro", docs: "https://docs.perplexity.ai/",  hint: "Generate at perplexity.ai/account/api" },
  { id: "anthropic", name: "Anthropic Claude", docs: "https://docs.anthropic.com/",     hint: "Generate at console.anthropic.com/keys" },
  { id: "deepseek", name: "DeepSeek",        docs: "https://api-docs.deepseek.com/",    hint: "Generate at platform.deepseek.com/api_keys" },
];

function ApiKeysTab() {
  const { toast } = useToast();
  const { data: keys = [] } = useQuery<any[]>({ queryKey: ["/api/keys"] });
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const saveMut = useMutation({
    mutationFn: async ({ service, apiKey }: { service: string; apiKey: string }) => {
      const res = await apiRequest("POST", "/api/keys", { service, apiKey });
      return res.json();
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/keys"] });
      setDrafts((d) => ({ ...d, [vars.service]: "" }));
      toast({ title: "Saved", description: `${vars.service} key stored` });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const testMut = useMutation({
    mutationFn: async (service: string) => {
      const res = await apiRequest("POST", `/api/keys/${service}/test`);
      return res.json();
    },
    onSuccess: (data, service) => {
      queryClient.invalidateQueries({ queryKey: ["/api/keys"] });
      toast({
        title: data.status === "ok" ? "Test passed" : "Test failed",
        description: `${service}: ${data.message}`,
        variant: data.status === "ok" ? "default" : "destructive",
      });
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (service: string) => {
      const res = await apiRequest("DELETE", `/api/keys/${service}`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/keys"] }),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Keys are stored in the Postgres database. On Railway you can override with{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">CEIC_API_KEY</code>,{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">SONAR_API_KEY</code>,{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">ANTHROPIC_API_KEY</code>,{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">DEEPSEEK_API_KEY</code> env vars
        (Phase 2 will read env first, then DB).
      </p>
      {SERVICES.map((svc) => {
        const stored = keys.find((k: any) => k.service === svc.id);
        const draft = drafts[svc.id] ?? "";
        return (
          <Card key={svc.id} className="p-4" data-testid={`apikey-card-${svc.id}`}>
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{svc.name}</h3>
                  {stored && (
                    <Badge variant="outline" className="font-normal text-[10px]">
                      Stored · {stored.masked}
                    </Badge>
                  )}
                  {stored?.testStatus === "ok" && (
                    <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/40 font-normal text-[10px]" variant="outline">
                      <CheckCircle2 className="h-3 w-3 mr-1" />ok
                    </Badge>
                  )}
                  {stored?.testStatus === "fail" && (
                    <Badge variant="destructive" className="font-normal text-[10px]">
                      <AlertCircle className="h-3 w-3 mr-1" />fail
                    </Badge>
                  )}
                </div>
                <div className="text-[12px] text-muted-foreground mt-1">{svc.hint}</div>
              </div>
              <a href={svc.docs} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1">
                Docs <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder={stored ? "Replace key…" : "Paste API key"}
                value={draft}
                onChange={(e) => setDrafts((d) => ({ ...d, [svc.id]: e.target.value }))}
                data-testid={`input-key-${svc.id}`}
                className="flex-1"
              />
              <Button
                onClick={() => saveMut.mutate({ service: svc.id, apiKey: draft.trim() })}
                disabled={!draft.trim() || saveMut.isPending}
                data-testid={`button-save-${svc.id}`}
              >
                Save
              </Button>
              <Button
                variant="outline"
                onClick={() => testMut.mutate(svc.id)}
                disabled={!stored || testMut.isPending}
                data-testid={`button-test-${svc.id}`}
              >
                Test
              </Button>
              {stored && (
                <Button
                  variant="ghost"
                  onClick={() => deleteMut.mutate(svc.id)}
                  data-testid={`button-delete-${svc.id}`}
                >
                  Delete
                </Button>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function DataSourcesTab() {
  const { toast } = useToast();
  const { data: settings = [] } = useQuery<any[]>({ queryKey: ["/api/settings"] });

  const ttls = settings.find((s) => s.key === "ttls")?.valueJson ?? {
    daily: 4 * 60,         // minutes
    monthly: 24 * 60,
    quarterly: 7 * 24 * 60,
    insights: 24 * 60,
  };
  const [draft, setDraft] = useState<any>(ttls);

  const saveMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/settings", { key: "ttls", valueJson: draft });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Saved", description: "Cache TTL defaults updated" });
    },
  });

  const rows = [
    { key: "daily", label: "Daily series (e.g. A-share close, FX)", suffix: "min" },
    { key: "monthly", label: "Monthly stats (PMI, CPI, IP, FAI)", suffix: "min" },
    { key: "quarterly", label: "Quarterly stats (GDP, earnings)", suffix: "min" },
    { key: "insights", label: "CEIC Insights feed", suffix: "min" },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Cache TTLs control how long fetched data is reused before refetching. Live CEIC pulls happen
        only when cache is expired or user clicks Refresh. (Phase 2 will respect these — Phase 1 has
        no live fetches yet.)
      </p>
      <Card className="p-4">
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center gap-3">
              <Label className="flex-1 text-sm font-normal">{r.label}</Label>
              <Input
                type="number"
                value={draft[r.key]}
                onChange={(e) => setDraft({ ...draft, [r.key]: Number(e.target.value) })}
                className="w-28"
                data-testid={`input-ttl-${r.key}`}
              />
              <span className="text-xs text-muted-foreground w-8">{r.suffix}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-between items-center">
          <Button variant="outline" disabled data-testid="button-refresh-all">
            Force refresh all (Phase 2)
          </Button>
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} data-testid="button-save-ttls">
            Save defaults
          </Button>
        </div>
      </Card>
    </div>
  );
}

function WatchlistsTab() {
  return (
    <Card className="p-6 text-center">
      <h3 className="text-sm font-semibold mb-1">Custom watchlists</h3>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        Build and save your own series watchlists in Phase 3. The default 117-series China watchlist
        (new/old/macro/financials) is loaded automatically once CEIC live data is wired in Phase 2.
      </p>
      <Badge variant="outline" className="mt-3 font-normal">Phase 3 feature</Badge>
    </Card>
  );
}

function CostLimitsTab() {
  const { toast } = useToast();
  const { data: ceilings = [] } = useQuery<any[]>({ queryKey: ["/api/ceilings"] });

  const upsertMut = useMutation({
    mutationFn: async (body: any) => {
      const res = await apiRequest("POST", "/api/ceilings", body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ceilings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/audit/summary"] });
      toast({ title: "Saved", description: "Ceiling updated" });
    },
  });

  const bumpMut = useMutation({
    mutationFn: async (service: string) => {
      const res = await apiRequest("POST", `/api/ceilings/${service}/bump`, { deltaUsd: 20 });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ceilings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/audit/summary"] });
      toast({ title: "+$20 added to ceiling" });
    },
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Hard stops block API calls when the monthly $ ceiling is hit. Toggle off for "alert-only" mode.
        CEIC also enforces a raw monthly call cap independent of $.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {ceilings.map((c: any) => {
          const pct = Math.min(100, (c.currentMonthUsd / c.monthlyLimitUsd) * 100);
          return (
            <Card key={c.service} className="p-4" data-testid={`ceiling-card-${c.service}`}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold capitalize">{c.service}</h3>
                <div className="flex items-center gap-2">
                  <Label htmlFor={`stop-${c.service}`} className="text-xs">Hard stop</Label>
                  <Switch
                    id={`stop-${c.service}`}
                    checked={c.hardStopEnabled}
                    onCheckedChange={(v) => upsertMut.mutate({ ...c, hardStopEnabled: v })}
                    data-testid={`switch-stop-${c.service}`}
                  />
                </div>
              </div>
              <div className="text-xs text-muted-foreground mb-2">
                ${c.currentMonthUsd.toFixed(2)} of ${c.monthlyLimitUsd.toFixed(2)} this month
              </div>
              <div className="h-1.5 bg-muted rounded-full mb-3 overflow-hidden">
                <div
                  className={`h-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Monthly $ cap</Label>
                  <Input
                    type="number"
                    defaultValue={c.monthlyLimitUsd}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== c.monthlyLimitUsd) upsertMut.mutate({ ...c, monthlyLimitUsd: v });
                    }}
                    data-testid={`input-limit-${c.service}`}
                  />
                </div>
                {c.service === "ceic" && (
                  <div>
                    <Label className="text-xs">Monthly call cap</Label>
                    <Input
                      type="number"
                      defaultValue={c.monthlyCallCap ?? ""}
                      onBlur={(e) => {
                        const v = e.target.value ? Number(e.target.value) : null;
                        if (v !== c.monthlyCallCap) upsertMut.mutate({ ...c, monthlyCallCap: v });
                      }}
                      data-testid={`input-callcap-${c.service}`}
                    />
                  </div>
                )}
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => bumpMut.mutate(c.service)}
                  data-testid={`button-bump-${c.service}`}
                >
                  +$20
                </Button>
                <div className="text-[11px] text-muted-foreground self-center">
                  Calls this month: {c.currentMonthCalls}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function DisplayTab() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-3">Theme</h3>
        <div className="flex gap-2">
          {(["light", "dark", "auto"] as const).map((t) => (
            <Button
              key={t}
              variant={theme === t ? "default" : "outline"}
              onClick={() => setTheme(t)}
              data-testid={`button-theme-${t}`}
              className="capitalize"
            >
              {t}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-3">Persists across sessions via Postgres.</p>
      </Card>
    </div>
  );
}

export default function Settings() {
  return (
    <div data-testid="page-settings">
      <PageHeader title="Settings" subtitle="API keys, cache rules, cost ceilings, and display preferences." />
      <Tabs defaultValue="keys">
        <TabsList>
          <TabsTrigger value="keys" data-testid="tab-keys">API Keys</TabsTrigger>
          <TabsTrigger value="sources" data-testid="tab-sources">Data Sources</TabsTrigger>
          <TabsTrigger value="watchlists" data-testid="tab-watchlists">Watchlists</TabsTrigger>
          <TabsTrigger value="cost" data-testid="tab-cost">Cost &amp; Limits</TabsTrigger>
          <TabsTrigger value="display" data-testid="tab-display">Display</TabsTrigger>
        </TabsList>
        <TabsContent value="keys" className="mt-4"><ApiKeysTab /></TabsContent>
        <TabsContent value="sources" className="mt-4"><DataSourcesTab /></TabsContent>
        <TabsContent value="watchlists" className="mt-4"><WatchlistsTab /></TabsContent>
        <TabsContent value="cost" className="mt-4"><CostLimitsTab /></TabsContent>
        <TabsContent value="display" className="mt-4"><DisplayTab /></TabsContent>
      </Tabs>
    </div>
  );
}
