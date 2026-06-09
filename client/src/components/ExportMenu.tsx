/**
 * ExportMenu — shared dropdown that downloads the current resource as
 * CSV / PDF / DOCX / PPTX. Wired to the Phase 4 export routes.
 *
 * Default endpoint: /api/{resource}/export?format=...
 * Override with `path` (e.g. "/api/report/123/export") for the strategy note.
 */

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";

export type ExportFormat = "csv" | "pdf" | "docx" | "pptx";

export interface ExportMenuProps {
  /** Logical resource name, e.g. "report", "policy". Used for the default URL + test ids. */
  resource: string;
  /** Explicit endpoint path override, e.g. "/api/report/123/export". */
  path?: string;
  /** Optional query string appended to the export URL (without leading ?). */
  query?: string;
  /** Restrict which formats are offered. Defaults to all four. */
  formats?: ExportFormat[];
  /** If true, formats are disabled (e.g. no data yet). */
  disabled?: boolean;
}

const ALL_FORMATS: Array<{ key: ExportFormat; label: string }> = [
  { key: "pdf", label: "PDF (.pdf)" },
  { key: "docx", label: "Word (.docx)" },
  { key: "pptx", label: "PowerPoint (.pptx)" },
  { key: "csv", label: "CSV (.csv)" },
];

export function ExportMenu({ resource, path, query, formats, disabled }: ExportMenuProps) {
  const { toast } = useToast();
  const offered = formats ? ALL_FORMATS.filter((f) => formats.includes(f.key)) : ALL_FORMATS;

  function handleExport(fmt: ExportFormat) {
    const baseUrl = path ?? `/api/${resource}/export`;
    const url = `${baseUrl}?format=${fmt}${query ? `&${query}` : ""}`;
    toast({ title: `Preparing ${fmt.toUpperCase()}…`, description: "Your download will begin shortly." });
    // Trigger the browser download.
    window.location.href = url;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          data-testid={`button-export-${resource}`}
          className="h-8 gap-1.5"
        >
          <Download className="h-3.5 w-3.5" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Download as
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {offered.map((f) => (
          <DropdownMenuItem
            key={f.key}
            onClick={() => handleExport(f.key)}
            data-testid={`export-${resource}-${f.key}`}
            className="text-sm"
          >
            {f.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
