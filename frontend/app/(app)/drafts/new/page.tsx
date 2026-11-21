"use client";

import { ArrowLeft, FilePen } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { alertSummary } from "@/components/alert-card";
import { DisclaimerBanner } from "@/components/disclaimer-banner";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { ErrorState, PageHeader } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NOTICE_LABEL } from "@/lib/format";
import { useAlerts, useCreateDraft, useIncidents } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import type { NoticeType } from "@/lib/types";
import { cn } from "@/lib/utils";

const TYPES: NoticeType[] = ["delay", "additional_cost", "defect", "concern"];
const NONE = "none";

function NewNoticeInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { role } = useApp();
  const alerts = useAlerts();
  const incidents = useIncidents();
  const create = useCreateDraft();
  const [type, setType] = useState<NoticeType>("delay");
  const [keywords, setKeywords] = useState("");
  const [alertId, setAlertId] = useState<string>(params.get("alert") ?? NONE);
  const [incidentId, setIncidentId] = useState<string>(params.get("incident") ?? NONE);

  const blocked = denyReason(role, "create_draft");
  const missing = !keywords.trim() && alertId === NONE && incidentId === NONE ? "Add a few keywords, or choose an alert or incident." : null;

  return (
    <>
      <Link href="/drafts" className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm hover:underline md:min-h-0">
        <ArrowLeft className="size-4" aria-hidden /> Notices
      </Link>
      <PageHeader title="New notice" description="Start from an alert, an incident, or a few keywords. SiteMate pulls in the relevant records and marks anything missing." />
      <div className="mb-4">
        <DisclaimerBanner />
      </div>
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>What is this notice about?</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(
                {
                  type,
                  keywords: keywords.trim() || null,
                  alert_id: alertId === NONE ? null : alertId,
                  incident_id: incidentId === NONE ? null : incidentId,
                },
                { onSuccess: (d) => router.push(`/drafts/${d.id}`) },
              );
            }}
          >
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Type of notice</legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {TYPES.map((t) => (
                  <label
                    key={t}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm focus-within:ring-2 focus-within:ring-ring",
                      type === t && "border-primary bg-muted font-medium",
                    )}
                  >
                    <input type="radio" name="type" value={t} checked={type === t} onChange={() => setType(t)} className="size-4" />
                    {NOTICE_LABEL[t]}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="from-alert">Based on an alert</Label>
              <Select value={alertId} onValueChange={setAlertId}>
                <SelectTrigger id="from-alert" className="h-11 md:h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No alert</SelectItem>
                  {alerts.data?.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.activity_code} · {alertSummary(a)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {alerts.isError && <p className="text-xs text-red-800">Alerts could not be loaded. You can still start from keywords.</p>}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="from-incident">Related incident</Label>
              <Select value={incidentId} onValueChange={setIncidentId}>
                <SelectTrigger id="from-incident" className="h-11 md:h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No incident</SelectItem>
                  {incidents.data?.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {incidents.isError && <p className="text-xs text-red-800">Incidents could not be loaded. You can still start from keywords.</p>}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="keywords">Keywords (optional)</Label>
              <Input id="keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="e.g. excavator breakdown, Zone B, foundations" className="h-11 md:h-9" />
            </div>

            {create.isError && <ErrorState error={create.error} />}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <GatedButton type="submit" reason={blocked ?? missing} size="touch" disabled={create.isPending} className="self-start">
                <FilePen aria-hidden /> Create notice
              </GatedButton>
              {!blocked && !missing && <p className="text-xs text-muted-foreground">You can edit the wording before anything is sent.</p>}
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}

export default function NewNoticePage() {
  return (
    <Suspense>
      <NewNoticeInner />
    </Suspense>
  );
}
