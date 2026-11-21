"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { AlertCircle, Inbox, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2 rounded-2xl border border-dashed bg-card/50 p-8 text-center", className)}>
      <div className="text-muted-foreground [&_svg]:size-6" aria-hidden>
        {icon ?? <Inbox />}
      </div>
      <p className="font-medium">{title}</p>
      {description && <div className="max-w-sm text-sm text-muted-foreground">{description}</div>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const status = error instanceof ApiError ? error.status : null;
  const message = error instanceof Error ? error.message : "Something went wrong";
  return (
    <div role="alert" className={cn("flex flex-col items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-red-900", className)}>
      <p className="flex items-center gap-2 font-medium">
        <AlertCircle className="size-4" aria-hidden />
        {status === 404 ? "Not available" : "Could not load"}
        {status ? <span className="text-xs font-normal opacity-70">(HTTP {status || "network"})</span> : null}
      </p>
      <p className="text-sm">{message}</p>
      {onRetry && (
        <Button variant="outline" size="touch" onClick={onRetry} className="bg-white">
          <RefreshCw aria-hidden /> Retry
        </Button>
      )}
    </div>
  );
}

export function LoadingSkeleton({ variant = "list", rows = 3, className }: { variant?: "list" | "cards" | "detail"; rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {variant === "detail" && <Skeleton className="h-8 w-2/3" />}
      {Array.from({ length: rows }).map((_, i) =>
        variant === "cards" || variant === "detail" ? (
          <Skeleton key={i} className="h-28 w-full" />
        ) : (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          </div>
        ),
      )}
    </div>
  );
}

/** Renders loading, error (with retry) and empty states around a query. */
export function QueryState<T>({
  query,
  children,
  loading,
  empty,
  isEmpty,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  loading?: ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
}) {
  if (query.isPending) return <>{loading ?? <LoadingSkeleton />}</>;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const data = query.data as T;
  const emptyCheck = isEmpty ?? ((d: T) => Array.isArray(d) && d.length === 0);
  if (empty && emptyCheck(data)) return <>{empty}</>;
  return <>{children(data)}</>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight md:text-[28px]">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
