import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Database, Globe, Sparkles, FileText, Clock, AlertCircle } from "lucide-react";

// ─── Legacy type (Phase 1) ────────────────────────────────────────────────────
export type ProvenanceType = "static" | "ceic" | "sonar" | "claude" | "deepseek" | "free" | "user";

// ─── Phase 2 extended source type ─────────────────────────────────────────────
export type ProvenanceSource = "ceic" | "nbs" | "stooq" | "yahoo" | "pending" | "static";

const LEGACY_STYLES: Record<ProvenanceType, { label: string; cls: string; icon: any }> = {
  static:   { label: "Static (May 2026)",  cls: "bg-muted text-muted-foreground",                                   icon: FileText  },
  ceic:     { label: "CEIC",               cls: "bg-blue-500/10 text-blue-700 dark:text-blue-300",                  icon: Database  },
  sonar:    { label: "Sonar Pro",           cls: "bg-violet-500/10 text-violet-700 dark:text-violet-300",            icon: Globe     },
  claude:   { label: "Claude synthesis",   cls: "bg-orange-500/10 text-orange-700 dark:text-orange-300",            icon: Sparkles  },
  deepseek: { label: "DeepSeek",           cls: "bg-teal-500/10 text-teal-700 dark:text-teal-300",                  icon: Sparkles  },
  free:     { label: "Free source",        cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",         icon: Globe     },
  user:     { label: "User-saved",         cls: "bg-pink-500/10 text-pink-700 dark:text-pink-300",                  icon: FileText  },
};

const SOURCE_STYLES: Record<ProvenanceSource, { label: string; cls: string; icon: any }> = {
  ceic:    { label: "CEIC",         cls: "bg-blue-500/10 text-blue-700 dark:text-blue-300",             icon: Database      },
  nbs:     { label: "NBS",          cls: "bg-red-500/10 text-red-700 dark:text-red-300",                icon: Database      },
  stooq:   { label: "Stooq",        cls: "bg-gray-500/10 text-gray-700 dark:text-gray-300",             icon: Globe         },
  yahoo:   { label: "Yahoo Finance", cls: "bg-purple-500/10 text-purple-700 dark:text-purple-300",      icon: Globe         },
  pending: { label: "Pending",       cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300",          icon: AlertCircle   },
  static:  { label: "Static",        cls: "bg-muted text-muted-foreground",                              icon: FileText      },
};

// ─── Helper: humanize timestamp ───────────────────────────────────────────────
function humanizeTs(ts: string): string {
  try {
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return ts;
  }
}

// ─── Phase 2 ProvenanceChip (new props signature) ─────────────────────────────
interface Phase2Props {
  source: ProvenanceSource;
  lastUpdated?: string;
  subscribed?: boolean;
  cacheHit?: boolean;
  error?: string;
}

export function ProvenanceChipLive({ source, lastUpdated, subscribed: _subscribed, cacheHit: _cacheHit, error }: Phase2Props) {
  const cfg = SOURCE_STYLES[source] ?? SOURCE_STYLES.pending;
  const Icon = cfg.icon;
  const humanTs = lastUpdated ? humanizeTs(lastUpdated) : null;

  const inner = (
    <Badge
      variant="secondary"
      className={`gap-1 font-normal ${cfg.cls}`}
      data-testid={`provenance-live-${source}`}
    >
      <Icon className="h-3 w-3" />
      <span>{cfg.label}</span>
      {humanTs && (
        <span className="opacity-60 ml-1 flex items-center gap-0.5">
          <Clock className="h-2.5 w-2.5" />
          {humanTs}
        </span>
      )}
    </Badge>
  );

  const tooltipContent = [
    lastUpdated ? `Updated: ${new Date(lastUpdated).toLocaleString()}` : null,
    error ? `Note: ${error}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (!tooltipContent) return inner;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{inner}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="text-xs max-w-xs break-words">{tooltipContent}</div>
      </TooltipContent>
    </Tooltip>
  );
}

// ─── Legacy ProvenanceChip (Phase 1 — unchanged API, still exported) ─────────
export function ProvenanceChip({
  type,
  detail,
  url,
  ts,
}: {
  type: ProvenanceType;
  detail?: string;
  url?: string;
  ts?: string;
}) {
  const cfg = LEGACY_STYLES[type] ?? LEGACY_STYLES.static;
  const Icon = cfg.icon;
  const inner = (
    <Badge variant="secondary" className={`gap-1 font-normal ${cfg.cls}`} data-testid={`provenance-${type}`}>
      <Icon className="h-3 w-3" />
      <span>{detail ?? cfg.label}</span>
      {ts && <span className="opacity-60 ml-1">· {ts}</span>}
    </Badge>
  );
  if (!url) return inner;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a href={url} target="_blank" rel="noreferrer">{inner}</a>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="text-xs max-w-xs break-words">{url}</div>
      </TooltipContent>
    </Tooltip>
  );
}
