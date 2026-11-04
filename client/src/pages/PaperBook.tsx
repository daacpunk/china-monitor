/**
 * Paper book — latest model portfolio marked to market since the note date.
 * Discussion tool. Not a live order blotter. Connect eligibility is not verified.
 */

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface Line {
  symbol: string;
  nameEn: string;
  theme: string;
  stance: string;
  weight: number | null;
  returnPct: number | null;
  contributionPct: number | null;
  latestDate: string | null;
  liquidity: string;
  note: string | null;
}

interface Book {
  noteId: number | null;
  noteTitle: string | null;
  noteDate: string | null;
  longWeight: number;
  bookReturnPct: number | null;
  pricedCount: number;
  lines: Line[];
  gaps: string[];
}

function n(v: number | null | undefined, d = 1): string {
  return v == null || Number.isNaN(v) ? "—" : v.toFixed(d);
}

export default function PaperBook() {
  const q = useQuery<Book>({
    queryKey: ["/api/equity/paper-book"],
    queryFn: async () => (await apiRequest("GET", "/api/equity/paper-book")).json(),
  });
  const d = q.data;

  return (
    <div>
      <PageHeader
        title="Paper Book"
        subtitle="The latest model portfolio, marked to market from the recommendation date. Weights are discussion weights, not orders. Stock Connect is not verified."
      />
      {q.isLoading && <Skeleton className="h-64 w-full" />}
      {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
      {d && !d.noteId && <p className="text-sm text-muted-foreground">No data-driven portfolio has been saved yet. Generate one from Strategy Report.</p>}
      {d?.noteId && (
        <div className="space-y-4">
          <Card className="p-4">
            <div className="text-xs uppercase text-muted-foreground">Since note #{d.noteId} · {d.noteDate}</div>
            <div className="mt-1 text-lg font-medium">{d.noteTitle}</div>
            <p className="mt-2 text-sm">Weighted long contribution {n(d.bookReturnPct, 2)} pp on {n(d.longWeight, 0)} stated long weight. Priced names: {d.pricedCount}.</p>
          </Card>
          <Card className="p-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Stance</TableHead>
                  <TableHead>Weight</TableHead>
                  <TableHead>Return</TableHead>
                  <TableHead>Contribution</TableHead>
                  <TableHead>Liquidity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.lines.map((l) => (
                  <TableRow key={l.symbol + l.stance}>
                    <TableCell>{l.nameEn} <span className="text-muted-foreground">{l.symbol}</span></TableCell>
                    <TableCell>{l.stance}</TableCell>
                    <TableCell>{n(l.weight, 0)}%</TableCell>
                    <TableCell>{n(l.returnPct)}%</TableCell>
                    <TableCell>{n(l.contributionPct, 2)}</TableCell>
                    <TableCell>{l.liquidity}{l.note ? ` · ${l.note}` : ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <div className="flex flex-wrap gap-2">
            {d.gaps.map((g) => <Badge key={g} variant="outline" className="font-normal">{g}</Badge>)}
          </div>
        </div>
      )}
    </div>
  );
}
