import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sparkles, RefreshCw } from "lucide-react";
import { useCommentaryMutation } from "@/hooks/useAnalysis";
import { cn } from "@/lib/utils";

interface Props {
  logicalId: string;
  /** Optional related series IDs to include as context for the LLM */
  contextIds?: string[];
}

// Commentary is a cheap path: Haiku stays the default here by design.
const MODELS = [
  { value: "claude-haiku-4", label: "Claude Haiku 4.5", hint: "fast · $1/$5 per Mtok" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5", hint: "best · $2/$10 per Mtok" },
  { value: "deepseek-chat", label: "DeepSeek Chat", hint: "cheapest" },
  { value: "deepseek-reasoner", label: "DeepSeek Reasoner", hint: "reasoning" },
];

export function AICommentaryPanel({ logicalId, contextIds }: Props) {
  const [model, setModel] = useState("claude-haiku-4");
  const [question, setQuestion] = useState("");
  const commentary = useCommentaryMutation();

  const run = () => {
    commentary.mutate({
      logicalId,
      model,
      question: question.trim() || undefined,
      contextIds,
    });
  };

  const data = commentary.data;
  const errMsg = (commentary.error as Error | undefined)?.message;

  // Render commentary with simple bold/bullet handling
  const renderText = (txt: string) =>
    txt.split("\n").map((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return <div key={i} className="h-2" />;
      if (trimmed.startsWith("•") || trimmed.startsWith("-")) {
        return (
          <div key={i} className="flex gap-2 pl-1">
            <span className="text-muted-foreground">•</span>
            <span dangerouslySetInnerHTML={{ __html: bold(trimmed.replace(/^[•\-]\s*/, "")) }} />
          </div>
        );
      }
      return <p key={i} dangerouslySetInnerHTML={{ __html: bold(trimmed) }} />;
    });

  return (
    <Card className="p-4" data-testid={`commentary-${logicalId}`}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">AI commentary · {logicalId}</h3>
        </div>
        <div className="flex items-center gap-2">
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger
              className="h-8 w-[180px] text-xs"
              data-testid="select-commentary-model"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODELS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  <div className="flex flex-col">
                    <span>{m.label}</span>
                    <span className="text-[10px] text-muted-foreground">{m.hint}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={run}
            disabled={commentary.isPending}
            data-testid="button-run-commentary"
            className="gap-1.5"
          >
            {commentary.isPending ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {data ? "Regenerate" : "Generate"}
          </Button>
        </div>
      </div>

      <Textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Optional · ask a specific question (e.g. 'is the deflation cycle broken?')"
        className="text-sm min-h-[60px] mb-3"
        data-testid="input-commentary-question"
      />

      {commentary.isPending && (
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </div>
      )}

      {errMsg && !commentary.isPending && (
        <div
          className={cn(
            "text-xs rounded-md border p-3",
            errMsg.includes("412") || errMsg.toLowerCase().includes("missing")
              ? "bg-amber-500/10 border-amber-500/30 text-amber-800 dark:text-amber-300"
              : "bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-300",
          )}
        >
          {errMsg.includes("412")
            ? "API key missing on server — set ANTHROPIC_API_KEY or DEEPSEEK_API_KEY."
            : errMsg.includes("429")
              ? "Cost ceiling reached. Check Settings or Audit page."
              : errMsg}
        </div>
      )}

      {data && !commentary.isPending && (
        <div className="space-y-3">
          <div className="text-sm leading-relaxed space-y-1.5">
            {renderText(data.commentary)}
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t text-[10px] text-muted-foreground">
            <Badge variant="outline" className="font-normal text-[10px]">
              {data.model}
            </Badge>
            {data.cacheHit && (
              <Badge variant="outline" className="font-normal text-[10px]">
                cache hit
              </Badge>
            )}
            <span>
              {data.tokensIn} in / {data.tokensOut} out
            </span>
            <span>${data.costUsd.toFixed(4)}</span>
            <span className="ml-auto">
              {new Date(data.fetchedAt).toLocaleString()}
            </span>
          </div>
        </div>
      )}

      {!data && !commentary.isPending && !errMsg && (
        <div className="text-xs text-muted-foreground italic">
          Click Generate for an analyst-style writeup using the latest CEIC data.
        </div>
      )}
    </Card>
  );
}

function bold(s: string) {
  // Minimal markdown bold: **text**
  return s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
