import { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  actions,
  meta,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4 pb-5 border-b">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" data-testid="page-title">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground" data-testid="page-subtitle">
            {subtitle}
          </p>
        )}
        {meta && <div className="mt-2 flex flex-wrap gap-1.5">{meta}</div>}
      </div>
      {actions && <div className="flex gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
