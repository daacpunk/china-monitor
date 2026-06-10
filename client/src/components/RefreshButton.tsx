/**
 * RefreshButton — reusable force-refresh button with spinner + toast feedback.
 *
 * Props:
 *   onRefresh  – async callback that triggers the refresh
 *   label      – optional button label (default "Refresh")
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface RefreshButtonProps {
  onRefresh: () => Promise<void>;
  label?: string;
}

export function RefreshButton({ onRefresh, label = "Refresh" }: RefreshButtonProps) {
  const [pending, setPending] = useState(false);
  const { toast } = useToast();

  async function handleClick() {
    if (pending) return;
    setPending(true);
    try {
      await onRefresh();
      toast({ title: "Refreshed", description: "Data updated successfully." });
    } catch (err) {
      toast({
        title: "Refresh failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={pending}
      data-testid="refresh-button"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} />
      {label}
    </Button>
  );
}
