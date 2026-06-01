import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { apiRequest } from "./queryClient";

export type Theme = "light" | "dark" | "auto";

interface ThemeCtx {
  theme: Theme;
  resolved: "light" | "dark";
  setTheme: (t: Theme) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

function resolveAuto(t: Theme): "light" | "dark" {
  if (t !== "auto") return t;
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Seed from system; load from server async.
  const [theme, setThemeState] = useState<Theme>("auto");
  const resolved = resolveAuto(theme);

  // Apply class.
  useEffect(() => {
    const root = document.documentElement;
    if (resolved === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  }, [resolved]);

  // Listen to system change when in auto mode.
  useEffect(() => {
    if (theme !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const r = resolveAuto("auto");
      if (r === "dark") document.documentElement.classList.add("dark");
      else document.documentElement.classList.remove("dark");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  // Load persisted theme from server.
  useEffect(() => {
    let cancelled = false;
    fetch(`${(import.meta as any).env.BASE_URL ?? ""}/api/view-state/theme`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const v = d?.valueJson;
        if (v === "light" || v === "dark" || v === "auto") {
          setThemeState(v);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    apiRequest("POST", "/api/view-state", { key: "theme", valueJson: t }).catch(() => {});
  };

  return <Ctx.Provider value={{ theme, resolved, setTheme }}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
