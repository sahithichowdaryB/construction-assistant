"use client";

import { CircleCheck, CircleX, Database, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SIMULATE_ERRORS_KEY } from "@/lib/api";
import { ENDPOINTS, servedFromFixtures, USE_FIXTURES, type EndpointKey } from "@/lib/endpoints";
import { useHealth, useProject } from "@/lib/queries";

function Missing({ value }: { value: string | null }) {
  return value ? (
    <>{value}</>
  ) : (
    <span className="inline-flex items-center gap-1 rounded border border-red-300 bg-red-50 px-1.5 text-xs font-medium text-red-800">
      <CircleX className="size-3" aria-hidden /> Missing
    </span>
  );
}

function ApiIndicator() {
  const health = useHealth();
  if (health.isPending) return <LoadingSkeleton rows={1} />;
  if (health.isError) return <ErrorState error={health.error} onRetry={() => void health.refetch()} />;
  const h = health.data;
  const ok = h.api === "connected";
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-medium ${ok ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
          {ok ? <CircleCheck className="size-4" aria-hidden /> : <CircleX className="size-4" aria-hidden />}
          API: {ok ? "connected" : h.api}
        </span>
        <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5">
          <Database className="size-4" aria-hidden /> Data: {h.mode === "fixtures" ? "fixtures" : "live API (planned routes on fixtures)"}
        </span>
        {h.database && <span className="text-muted-foreground">database {h.database}</span>}
      </p>
      {h.detail && <p className="text-muted-foreground">{h.detail}</p>}
      <Button variant="outline" size="touch" className="self-start" onClick={() => void health.refetch()}>
        <RefreshCw aria-hidden /> Check again
      </Button>
    </div>
  );
}

export default function SettingsPage() {
  const project = useProject();
  const qc = useQueryClient();
  const [simulate, setSimulate] = useState(false);

  useEffect(() => {
    try {
      setSimulate(window.localStorage.getItem(SIMULATE_ERRORS_KEY) === "1");
    } catch {
      /* storage unavailable */
    }
  }, []);

  const toggleSimulate = (on: boolean) => {
    setSimulate(on);
    try {
      if (on) window.localStorage.setItem(SIMULATE_ERRORS_KEY, "1");
      else window.localStorage.removeItem(SIMULATE_ERRORS_KEY);
    } catch {
      /* storage unavailable */
    }
    void qc.invalidateQueries({ queryKey: ["sm"] });
  };

  return (
    <>
      <PageHeader title="Settings" description="Project record (read-only) and data source." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Project</CardTitle>
          </CardHeader>
          <CardContent>
            <QueryState query={project} loading={<LoadingSkeleton rows={4} />}>
              {(p) => (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Name</dt>
                  <dd>{p.name} ({p.id})</dd>
                  <dt className="text-muted-foreground">Time zone</dt>
                  <dd>{p.timezone}</dd>
                  <dt className="text-muted-foreground">Alert threshold</dt>
                  <dd>Shortfall above {p.thresholds.deviation_pct}%</dd>
                  <dt className="text-muted-foreground">High severity</dt>
                  <dd>Shortfall above {p.thresholds.high_above_pct}%</dd>
                  <dt className="text-muted-foreground">Sender</dt>
                  <dd>
                    {p.sender.name}
                    {p.sender.address && <span className="block text-muted-foreground">{p.sender.address}</span>}
                  </dd>
                  <dt className="text-muted-foreground">Recipient</dt>
                  <dd>
                    {p.recipient.name}
                    {p.recipient.address && <span className="block text-muted-foreground">{p.recipient.address}</span>}
                  </dd>
                  <dt className="text-muted-foreground">Contract reference</dt>
                  <dd><Missing value={p.contract_reference} /></dd>
                  <dt className="text-muted-foreground">Contract clause</dt>
                  <dd><Missing value={p.contract_clause} /></dd>
                  <dt className="text-muted-foreground">Rate table</dt>
                  <dd><Missing value={p.rate_table} /></dd>
                  <dt className="text-muted-foreground">Calendar</dt>
                  <dd>{p.calendar_note ?? "Unknown"}</dd>
                </dl>
              )}
            </QueryState>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>API status</CardTitle>
            </CardHeader>
            <CardContent>
              <ApiIndicator />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Endpoints</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                NEXT_PUBLIC_USE_FIXTURES={String(USE_FIXTURES)}. Routes marked “fixture” are served in the browser until the backend ships them.
              </p>
              <ul className="flex flex-col divide-y rounded-md border text-xs">
                {(Object.keys(ENDPOINTS) as EndpointKey[]).map((k) => (
                  <li key={k} className="flex items-center justify-between gap-2 px-2 py-1.5">
                    <span className="font-mono break-all">{ENDPOINTS[k].route}</span>
                    <span className={servedFromFixtures(k) ? "text-muted-foreground" : "font-medium text-emerald-700"}>
                      {servedFromFixtures(k) ? "fixture" : "live"}
                    </span>
                  </li>
                ))}
              </ul>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" className="size-5" checked={simulate} onChange={(e) => toggleSimulate(e.target.checked)} />
                Simulate API errors for fixture routes (to check error and retry states)
              </label>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
