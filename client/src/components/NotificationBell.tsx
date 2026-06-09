/**
 * NotificationBell (Phase 5) — header bell with unread count + dropdown list.
 *
 * Polls /api/notifications. Clicking a notification marks it read and (if it
 * carries a link) navigates there. "Mark all read" clears the badge.
 */

import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bell, CheckCheck, FileText, AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface NotificationItem {
  id: number; title: string; body: string; link: string | null;
  read: boolean; kind: string; createdAt: string;
}

function iconFor(kind: string) {
  if (kind === "report_ready") return FileText;
  if (kind === "job_failed") return AlertTriangle;
  return Info;
}

function timeAgo(s: string): string {
  try {
    const diff = Date.now() - new Date(s).getTime();
    const m = Math.round(diff / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  } catch { return ""; }
}

export function NotificationBell() {
  const [, navigate] = useLocation();

  const q = useQuery<{ notifications: NotificationItem[]; unread: number }, Error>({
    queryKey: ["/api/notifications"],
    queryFn: async () => (await apiRequest("GET", "/api/notifications")).json(),
    refetchInterval: 30_000,
  });

  const readMutation = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/notifications/${id}/read`, {})).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }),
  });
  const readAllMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/notifications/read-all", {})).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }),
  });

  const items = q.data?.notifications ?? [];
  const unread = q.data?.unread ?? 0;

  const onClickItem = (n: NotificationItem) => {
    if (!n.read) readMutation.mutate(n.id);
    if (n.link) {
      // links are stored as hash routes (e.g. "/report"); strip any leading "#"
      navigate(n.link.replace(/^#/, ""));
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-9 w-9" data-testid="notification-bell" title="Notifications">
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground"
              data-testid="notification-count"
            >
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="text-sm font-semibold">Notifications</div>
          {unread > 0 && (
            <Button
              variant="ghost" size="sm" className="h-7 gap-1 text-xs"
              onClick={() => readAllMutation.mutate()}
              data-testid="button-mark-all-read"
            >
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </Button>
          )}
        </div>
        <ScrollArea className="max-h-96">
          {items.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">No notifications yet.</div>
          ) : (
            <div className="divide-y">
              {items.map((n) => {
                const Icon = iconFor(n.kind);
                return (
                  <button
                    key={n.id}
                    onClick={() => onClickItem(n)}
                    className={cn(
                      "flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover-elevate",
                      !n.read && "bg-primary/5",
                    )}
                    data-testid={`notification-${n.id}`}
                  >
                    <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", n.kind === "job_failed" ? "text-red-600" : "text-muted-foreground")} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className={cn("truncate text-sm", !n.read && "font-medium")}>{n.title}</div>
                        <div className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(n.createdAt)}</div>
                      </div>
                      {n.body && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</div>}
                    </div>
                    {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
