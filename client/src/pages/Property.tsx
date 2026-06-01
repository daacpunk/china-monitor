import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { DATA, LAST_UPDATED } from "@/data/staticData";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function Property() {
  const p = DATA.property;
  return (
    <div data-testid="page-property">
      <PageHeader
        title="Property sector"
        subtitle="The old-economy anchor — investment, starts, completions, sales, inventory."
        meta={<><ProvenanceChip type="static" detail={`Static · ${LAST_UPDATED}`} /><ProvenanceChip type="ceic" detail="CEIC: wires Phase 2" /></>}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wider">Home prices from peak</div>
          <div className="mt-1.5 text-2xl font-semibold text-red-600 dark:text-red-400">{p.homePricesFromPeak}%</div>
          <div className="text-[11px] text-muted-foreground mt-1">Tier-1/2 city benchmark</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wider">"Zombie" share of RE bank loans</div>
          <div className="mt-1.5 text-2xl font-semibold text-red-600 dark:text-red-400">{p.zombieShareRE}%</div>
          <div className="text-[11px] text-muted-foreground mt-1">Loans to non-viable developers</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wider">"Zombie" share of all bank loans</div>
          <div className="mt-1.5 text-2xl font-semibold text-amber-600 dark:text-amber-400">{p.zombieShareOverall}%</div>
          <div className="text-[11px] text-muted-foreground mt-1">Systemic credit overhang</div>
        </Card>
      </div>

      <Card className="p-5">
        <h2 className="text-sm font-semibold mb-3">Property indicators (YoY %)</h2>
        <Table>
          <TableHeader><TableRow><TableHead>Metric</TableHead><TableHead className="text-right">2024</TableHead><TableHead className="text-right">2025</TableHead></TableRow></TableHeader>
          <TableBody>
            {p.metrics.map((m: any) => (
              <TableRow key={m.metric}>
                <TableCell className="text-sm">{m.metric}</TableCell>
                <TableCell className="text-right tabular-nums text-sm">{m.y2024}</TableCell>
                <TableCell className="text-right tabular-nums text-sm font-medium">{m.y2025}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
