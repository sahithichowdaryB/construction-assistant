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
import { useAlerts, useCreateDraft } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import type { NoticeType } from "@/lib/types";
import { cn } from "@/lib/utils";

const TYPES: NoticeType[] = ["delay", "additional_cost", "defect", "concern"];

function NewDraftInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { role } = useApp();
  const alerts = useAlerts();
  const create = useCreateDraft();
  const [type, setType] = useState<NoticeType>("delay");
  const [keywords, setKeywords] = useState("");
  const [alertId, setAlertId] = useState<string>(params.get("alert") ?? "none");

  const blocked = denyReason(role, "create_draft");
  const missing = !keywords.trim() && alertId === "none" ? "Enter keywords or choose an alert." : null;

  return (
    <>
      <Link href="/drafts" className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm hover:underline md:min-h-0">
        <ArrowLeft className="size-4" aria-hidden /> Drafts
      </Link>
      <PageHeader title="New draft" description="Start from keywords or from an open alert. SiteMate retrieves dated evidence and marks every gap." />
      <div className="mb-4">
        <DisclaimerBanner />
      </div>
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Notice</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(
                { type, keywords: keywords.trim() || null, alert_id: alertId === "none" ? null : alertId },
                { onSuccess: (d) => router.push(`/drafts/${d.id}`) },
              );
            }}
          >
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Notice type</legend>
              <div className="grid grid-cols-2 gap-2">
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
              <Label htmlFor="keywords">Keywords</Label>
              <Input id="keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="e.g. EX-02 breakdown, Zone B, foundations" className="h-11 md:h-9" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="from-alert">Start from alert (optional)</Label>
              <Select value={alertId} onValueChange={setAlertId}>
                <SelectTrigger id="from-alert" className="h-11 md:h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No alert</SelectItem>
                  {alerts.data?.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.activity_code} · {alertSummary(a)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {alerts.isError && <p className="text-xs text-red-800">Alerts could not be loaded; you can still draft from keywords.</p>}
            </div>
            {create.isError && <ErrorState error={create.error} />}
            <GatedButton type="submit" reason={blocked ?? missing} size="touch" disabled={create.isPending} className="self-start">
              <FilePen aria-hidden /> Create draft
            </GatedButton>
          </form>
        </CardContent>
      </Card>
    </>
  );
}

export default function NewDraftPage() {
  return (
    <Suspense>
      <NewDraftInner />
    </Suspense>
  );
}
