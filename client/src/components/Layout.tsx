import { Link, useLocation } from "wouter";
import { ReactNode } from "react";
import {
  LayoutDashboard,
  TrendingUp,
  Building2,
  Landmark,
  LineChart,
  Activity,
  Factory,
  Telescope,
  Settings,
  Receipt,
  Upload,
  Moon,
  Sun,
  Monitor,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";

const SECTIONS: Array<{ slug: string; label: string; icon: any; group: string }> = [
  { slug: "/", label: "Overview", icon: LayoutDashboard, group: "Dashboard" },
  { slug: "/investment", label: "Investment / FAI", icon: TrendingUp, group: "Dashboard" },
  { slug: "/gdp", label: "GDP & Energy", icon: Activity, group: "Dashboard" },
  { slug: "/fiscal", label: "Fiscal / Policy", icon: Landmark, group: "Dashboard" },
  { slug: "/equity", label: "Equities", icon: LineChart, group: "Dashboard" },
  { slug: "/kshape", label: "K-shape Monitor", icon: TrendingUp, group: "Dashboard" },
  { slug: "/margins", label: "PPI & Margins", icon: Factory, group: "Dashboard" },
  { slug: "/property", label: "Property", icon: Building2, group: "Dashboard" },
  { slug: "/outlook", label: "Outlook", icon: Telescope, group: "Dashboard" },
];

const SYSTEM_LINKS = [
  { slug: "/imports", label: "Imports", icon: Upload },
  { slug: "/audit", label: "Audit Trail", icon: Receipt },
  { slug: "/settings", label: "Settings", icon: Settings },
];

export function Layout({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside
        className="w-64 shrink-0 border-r bg-sidebar text-sidebar-foreground flex flex-col"
        data-testid="sidebar"
      >
        <div className="px-5 py-5 border-b border-sidebar-border">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-md bg-sidebar-primary flex items-center justify-center text-sidebar-primary-foreground font-semibold text-sm">
              中
            </div>
            <div>
              <div className="font-semibold text-sm leading-tight">China Monitor</div>
              <div className="text-[11px] text-muted-foreground leading-tight">Dynamic Research</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          <div>
            <div className="px-2 mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              Dashboard
            </div>
            <div className="space-y-0.5">
              {SECTIONS.map((s) => {
                const active = loc === s.slug;
                const Icon = s.icon;
                return (
                  <Link
                    key={s.slug}
                    href={s.slug}
                    data-testid={`nav-${s.slug.replace("/", "") || "overview"}`}
                    className={cn(
                      "flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm hover-elevate",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                        : "text-sidebar-foreground/80",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{s.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>

          <div>
            <div className="px-2 mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              System
            </div>
            <div className="space-y-0.5">
              {SYSTEM_LINKS.map((s) => {
                const active = loc === s.slug;
                const Icon = s.icon;
                return (
                  <Link
                    key={s.slug}
                    href={s.slug}
                    data-testid={`nav-${s.slug.replace("/", "")}`}
                    className={cn(
                      "flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm hover-elevate",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                        : "text-sidebar-foreground/80",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{s.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </nav>

        <div className="border-t border-sidebar-border p-3">
          <div className="flex gap-1">
            <Button
              variant={theme === "light" ? "secondary" : "ghost"}
              size="icon"
              className="h-7 w-7"
              onClick={() => setTheme("light")}
              data-testid="theme-light"
              title="Light"
            >
              <Sun className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={theme === "dark" ? "secondary" : "ghost"}
              size="icon"
              className="h-7 w-7"
              onClick={() => setTheme("dark")}
              data-testid="theme-dark"
              title="Dark"
            >
              <Moon className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={theme === "auto" ? "secondary" : "ghost"}
              size="icon"
              className="h-7 w-7"
              onClick={() => setTheme("auto")}
              data-testid="theme-auto"
              title="Auto"
            >
              <Monitor className="h-3.5 w-3.5" />
            </Button>
            <div className="flex-1 text-right text-[10px] text-muted-foreground self-center pr-1">
              Phase 1
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto" data-testid="main-content">
        <div className="max-w-7xl mx-auto px-8 py-6">{children}</div>
      </main>
    </div>
  );
}
