"use client";

import { HardHat } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { RECORDINGS_KEY } from "@/components/recordings-list";
import { useApp } from "@/components/providers/app-context";
import { listRecordings } from "@/lib/agent";
import { useSession } from "@/lib/auth";
import { membershipFor } from "@/lib/session";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { useFieldNotes } from "@/lib/workflow";
import { fmtDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export default function MyReportsPage() {
  const notes = useFieldNotes(true);
  const { projectId } = useApp();
  const session = useSession();
  const member = membershipFor(session.data, projectId);
  const captures = useQuery({
    queryKey: [...RECORDINGS_KEY(projectId), member?.member_id],
    queryFn: () => listRecordings(projectId),
    enabled: !!member,
    refetchOnMount: "always",
    refetchInterval: 15_000,
  });
  const reports = [
    ...(notes.data ?? []).map((n) => ({
      id: n.source_id, date: n.recorded_at, text: n.text, author: n.author, photos: [],
      status: n.status === "confirmed" ? "Reported to site manager" : "Waiting for confirmation",
      code: n.facts.find((f) => f.field === "activity_code")?.value,
    })),
    ...(captures.data ?? []).filter((n) => member && n.author === member.member_id).map((n) => ({
      id: n.id, date: n.recorded_at, author: member?.display_name, status: "Saved to site diary", photos: n.photos ?? [],
      text: n.transcript || n.incidents[0]?.title || String(n.facts.find((f) => f.field_name === "summary")?.value ?? "Site note"),
      code: n.facts.find((f) => f.field_name === "activity_code")?.value,
    })),
  ].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return (
    <>
      <PageHeader title="My reports" description="Your field reports and the site notes you have reviewed and saved." />
      <section className="rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="recent-title">
        <h2 id="recent-title" className="mb-3 flex items-center gap-2 text-base font-semibold">
          <HardHat className="size-4 text-muted-foreground" aria-hidden /> Recent field reports
        </h2>
        {notes.isError && <ErrorState error={notes.error} onRetry={() => void notes.refetch()} />}
        {captures.isError && <ErrorState error={captures.error} onRetry={() => void captures.refetch()} />}
        {session.isError && <ErrorState error={session.error} onRetry={() => void session.refetch()} />}
        {reports.length === 0 && (notes.isLoading || captures.isLoading || session.isLoading) ? (
          <LoadingSkeleton rows={2} />
        ) : reports.length ? (
          <ul className="flex flex-col gap-2">
            {reports.map((n) => {
              return (
                <li key={n.id} className="rounded-xl border p-3 text-sm">
                  <p className="line-clamp-3">“{n.text}”</p>
                  {!!n.photos.length && <div className="mt-2 flex flex-wrap gap-2">
                    {n.photos.map((photo, index) => {
                      const url = `/api/sm/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(photo.id)}`;
                      return <a key={photo.id} href={url} target="_blank" rel="noreferrer" aria-label={`Open photo ${index + 1}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt={photo.description || `Site photo ${index + 1}`} loading="lazy" className="size-24 rounded-lg border object-cover" />
                      </a>;
                    })}
                  </div>}
                  <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className={cn("rounded-full px-2 py-0.5 font-medium", n.status === "Waiting for confirmation" ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-800")}>
                      {n.status}
                    </span>
                    {typeof n.code === "string" && <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{n.code}</span>}
                    {fmtDateTime(n.date)} · {n.author}
                  </p>
                </li>
              );
            })}
          </ul>
        ) : !(notes.isError || captures.isError || session.isError) && (
          <EmptyState title="No reports yet" description="Your field reports appear here after you record them." />
        )}
      </section>
    </>
  );
}
