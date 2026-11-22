import { Loader2 } from "lucide-react";
import { LoadingBar } from "@/components/loading-bar";
import { Skeleton } from "@/components/ui/skeleton";

const card = "rounded-[22px] bg-card p-5 md:p-6";

/** Small spinner with a message, for the top of a loading card. */
export function LoadingNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden /> {children}
    </p>
  );
}

/** Three white metric cards, the shape of the Performance headline tiles. */
export function KpiTilesSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-3" role="status" aria-label="Loading metrics">
      {[0, 1, 2].map((i) => (
        <div key={i} className={`${card} flex flex-col gap-4`}>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}

/** Two side-by-side white cards with rows, the shape of "Why late" and "What would help". */
export function InsightCardsSkeleton() {
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" role="status" aria-label="Loading insights">
      {[0, 1].map((i) => (
        <div key={i} className={`${card} flex flex-col gap-4`}>
          <Skeleton className="h-5 w-40" />
          {[0, 1].map((r) => (
            <div key={r} className="flex items-center gap-3">
              <Skeleton className="size-10 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-2"><Skeleton className="h-4 w-3/5" /><Skeleton className="h-3 w-2/5" /></div>
              <Skeleton className="h-8 w-20 rounded-full" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A white card with a title and a chart area. */
export function ChartCardSkeleton({ label = "Loading chart" }: { label?: string }) {
  return (
    <section className={`${card} flex flex-col gap-4`} role="status" aria-label={label}>
      <Skeleton className="h-5 w-48" />
      <div className="flex h-56 items-end gap-2">
        {[35, 50, 42, 60, 55, 72, 66, 84, 78, 92].map((h, i) => <Skeleton key={i} className="flex-1 rounded-t-md rounded-b-none" style={{ height: `${h}%` }} />)}
      </div>
    </section>
  );
}

/** The full right-hand Performance body: tiles, insights and the progress chart. */
export function PerformanceBodySkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <LoadingNote>Loading performance figures…</LoadingNote>
      <KpiTilesSkeleton />
      <InsightCardsSkeleton />
      <ChartCardSkeleton label="Loading progress chart" />
    </div>
  );
}

/** Title and description placeholder, the same size as PageHeader so nothing jumps when the page arrives. */
function HeaderSkeleton() {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56 md:w-72" />
        <Skeleton className="h-4 w-72 max-w-full md:w-96" />
      </div>
      <Skeleton className="h-10 w-40 rounded-xl" />
    </div>
  );
}

function Shell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <LoadingBar />
      <span className="sr-only">{label}</span>
      <HeaderSkeleton />
      {children}
    </div>
  );
}

/** Default while any page opens: header plus a few content cards. */
export function PageSkeleton({ label = "Loading page…" }: { label?: string }) {
  return (
    <Shell label={label}>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    </Shell>
  );
}

/** Rows of items, for activity, action and draft lists. */
export function ListPageSkeleton({ label = "Loading…", rows = 6 }: { label?: string; rows?: number }) {
  return (
    <Shell label={label}>
      <div className="flex flex-col gap-4">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}

/** Metric tiles, a chart and a list, for the Performance screens. */
export function DashboardPageSkeleton({ label = "Loading performance…" }: { label?: string }) {
  return (
    <Shell label={label}>
      <Skeleton className="mb-4 h-10 w-full max-w-md rounded-xl" />
      <PerformanceBodySkeleton />
    </Shell>
  );
}

/** Tiles, for the Documents library. */
export function GridPageSkeleton({ label = "Loading documents…" }: { label?: string }) {
  return (
    <Shell label={label}>
      <DocumentsGridSkeleton />
    </Shell>
  );
}

/** Document tiles as white cards with an icon, a title and a date line. */
export function DocumentsGridSkeleton() {
  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" role="status" aria-label="Loading documents">
      {Array.from({ length: 10 }, (_, i) => (
        <li key={i} className="flex h-32 flex-col gap-3 rounded-2xl bg-card p-4">
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-3 w-1/2" />
        </li>
      ))}
    </ul>
  );
}

/** Row of document-type tiles (the counters at the top of Documents). */
export function DocumentTilesSkeleton() {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7" role="status" aria-label="Loading document counts">
      {Array.from({ length: 7 }, (_, i) => (
        <li key={i} className="flex flex-col gap-3 rounded-[18px] bg-card p-4">
          <Skeleton className="size-5 rounded-md" />
          <Skeleton className="h-8 w-10" />
          <Skeleton className="h-3 w-16" />
        </li>
      ))}
    </ul>
  );
}
