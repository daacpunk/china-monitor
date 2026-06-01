import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Database, Globe, Sparkles, FileText } from "lucide-react";

export type ProvenanceType = "static" | "ceic" | "sonar" | "claude" | "deepseek" | "free" | "user";

const STYLES: Record<ProvenanceType, { label: string; cls: string; icon: any }> = {
  static: { label: "Static (May 2026)", cls: "bg-muted text-muted-foreground", icon: FileText },
  ceic:   { label: "CEIC",              cls: "bg-blue-500/10 text-blue-700 dark:text-blue-300", icon: Database },
  sonar:  { label: "Sonar Pro",         cls: "bg-violet-500/10 text-violet-700 dark:text-violet-300", icon: Globe },
  claude: { label: "Claude synthesis",  cls: "bg-orange-500/10 text-orange-700 dark:text-orange-300", icon: Sparkles },
  deepseek: { label: "DeepSeek",        cls: "bg-teal-500/10 text-teal-700 dark:text-teal-300", icon: Sparkles },
  free:   { label: "Free source",       cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", icon: Globe },
  user:   { label: "User-saved",        cls: "bg-pink-500/10 text-pink-700 dark:text-pink-300", icon: FileText },
};

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
  const cfg = STYLES[type];
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
