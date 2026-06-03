/**
 * ExportMenu — shared dropdown that lets the user download the current page as
 * CSV, PDF, DOCX, or PPTX. Wired to /api/{resource}/export?format=...
 *
 * For Phase 3b session 1, the backend routes aren't built yet, so each item
 * triggers a toast saying "Coming in session 4". Once the backend is in,
 * just remove the toast branch and let the link download trigger.
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
  /** Logical resource name, e.g. "trends", "attribution", "scenarios", "costs". */
  resource: string;
  /** Optional query string appended to the export URL (without leading ?). */
  query?: string;
  /** Default filename (without extension). Defaults to `${resource}`. */
  filename?: string;
  /** If true, formats are disabled (e.g. no data yet). */
  disabled?: boolean;
}

const FORMATS: Array<{ key: ExportFormat; label: string; ext: string }> = [
  { key: "csv", label: "CSV (.csv)", ext: "csv" },
  { key: "pdf", label: "PDF (.pdf)", ext: "pdf" },
  { key: "docx", label: "Word (.docx)", ext: "docx" },
  { key: "pptx", label: "PowerPoint (.pptx)", ext: "pptx" },
];

export function ExportMenu({ resource, query, filename, disabled }: ExportMenuProps) {
  const { toast } = useToast();

  const fname = filename ?? resource;

  function handleExport(fmt: ExportFormat) {
    // Backend routes are added in session 4. For now show a coming-soon toast.
    // When implemented: window.location.href = `/api/${resource}/export?format=${fmt}${query ? `&${query}` : ""}`;
    toast({
      title: "Export coming soon",
      description: `${fmt.toUpperCase()} export for ${resource} arrives in the final Phase 3b session.`,
    });
    void fname; // currently unused; will be sent as ?filename= in session 4
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
        {FORMATS.map((f) => (
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
