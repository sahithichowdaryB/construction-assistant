"use client";

import { ChevronRight, FilePen, Siren, Sun } from "lucide-react";
import Link from "next/link";
import { AlertCard } from "@/components/alert-card";
import { DraftStatusBadge } from "@/components/badges";
import { CitationChip, CitationList } from "@/components/citation-chip";
import { ProgressBar } from "@/components/progress-bar";
import { EmptyState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { TimelineStages } from "@/components/timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NOTICE_LABEL } from "@/lib/format";
import { useActivities, useToday } from "@/lib/queries";
import { fmtDateTime, fmtLocalDate, fmtShort } from "@/lib/time";

function Section({ title, icon, children, action }: { title: string; icon?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          {icon}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function TodayPage() {
  const today = useToday();
  const activities = useActivities();
  const byCode = new Map(activities.data?.map((a) => [a.code, a]));

  return (
    <>
      <PageHeader
        title="Today"
        description={today.data ? `Work date ${fmtLocalDate(today.data.work_date)} · as of ${fmtDateTime(today.data.as_of)}` : "Morning briefing"}
      />
      <QueryState query={today} loading={<LoadingSkeleton variant="cards" rows={4} />}>
        {(t) => (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="flex flex-col gap-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Sun className="size-5 text-amber-500" aria-hidden /> Briefing
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p className="font-medium">{t.briefing.headline}</p>
                  {t.briefing.bullets.length ? (
                    <ul className="flex flex-col gap-2 text-sm">
                      {t.briefing.bullets.map((b, i) => (
                        <li key={i} className="flex flex-col gap-1 border-l-2 pl-3">
                          <span>{b.text}</span>
                          <CitationList refs={b.refs} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">No briefing items for this time.</p>
                  )}
                </CardContent>
              </Card>

              <Section title="Today's activities">
                {t.activities.length ? (
                  <ul className="flex flex-col divide-y rounded-lg border">
                    {t.activities.map((a) => (
                      <li key={a.code} className="flex flex-col gap-2 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Link
                            href={`/schedule?code=${encodeURIComponent(a.code)}&date=${t.work_date}`}
                            className="text-sm hover:underline"
                          >
                            <span className="font-mono font-semibold">{a.code}</span> {a.name}
                            <span className="text-muted-foreground"> · zone {a.zone}</span>
                          </Link>
                          <span className="flex flex-wrap gap-1">
                            <CitationChip refData={a.plan_ref} />
                            {a.actual_ref ? (
                              <CitationChip refData={a.actual_ref} />
                            ) : (
                              <span className="text-xs text-muted-foreground">No report yet</span>
                            )}
                          </span>
                        </div>
                        <ProgressBar planned={a.planned} actual={a.actual} unit={a.unit} basis={a.basis} shortfallPct={a.shortfall_pct} severity={a.severity} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState title="No activities scheduled" description="The programme has no planned work on this date." />
                )}
              </Section>
            </div>

            <div className="flex flex-col gap-6">
              <Section
                title={`Open alerts (${t.open_alerts.length})`}
                action={
                  <Link href="/alerts" className="text-sm underline underline-offset-2">
                    All alerts
                  </Link>
                }
              >
                {t.open_alerts.length ? (
                  <div className="flex flex-col gap-2">
                    {t.open_alerts.map((a) => (
                      <AlertCard key={a.id} alert={a} activity={byCode.get(a.activity_code)} />
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No open alerts" description="No signed shortfall above the project threshold at this time." />
                )}
              </Section>

              <Section title={`Open incidents (${t.open_incidents.length})`} icon={<Siren className="size-4" aria-hidden />}>
                {t.open_incidents.length ? (
                  <ul className="flex flex-col gap-2">
                    {t.open_incidents.map((i) => (
                      <li key={i.id} className="relative rounded-lg border p-3">
                        <Link href={`/incidents/${i.id}`} className="font-medium after:absolute after:inset-0 hover:underline">
                          {i.title}
                        </Link>
                        <p className="text-xs text-muted-foreground">Reported {fmtShort(i.reported_at)}</p>
                        <div className="relative z-10 mt-2 flex flex-col gap-2">
                          <TimelineStages events={i.timeline} />
                          <CitationList refs={i.refs} />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState title="No open incidents" />
                )}
              </Section>

              <Section title="Drafts awaiting review" icon={<FilePen className="size-4" aria-hidden />}>
                {t.drafts_awaiting_review.length ? (
                  <ul className="flex flex-col gap-2">
                    {t.drafts_awaiting_review.map((d) => (
                      <li key={d.id}>
                        <Link href={`/drafts/${d.id}`} className="flex items-center justify-between gap-2 rounded-lg border p-3 hover:bg-muted/50">
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{d.title}</span>
                            <span className="text-xs text-muted-foreground">
                              {NOTICE_LABEL[d.type]} · v{d.latest_version} · {d.open_gaps} open gap{d.open_gaps === 1 ? "" : "s"}
                            </span>
                          </span>
                          <span className="flex items-center gap-1">
                            <DraftStatusBadge status={d.status} />
                            <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState title="Nothing awaiting review" />
                )}
              </Section>
            </div>
          </div>
        )}
      </QueryState>
    </>
  );
}
