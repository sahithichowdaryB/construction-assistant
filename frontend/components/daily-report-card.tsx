"use client";

import { CalendarClock, CalendarPlus, FileText, Search, X } from "lucide-react";
import { useState } from "react";
import { CitationChip } from "@/components/citation-chip";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  APPOINTMENT_KINDS,
  KIND_LABEL,
  useAddAppointment,
  useAppointments,
  useCancelAppointment,
  useDailyReport,
  useDraftDailyReport,
  useExtractAppointments,
  type AppointmentKind,
} from "@/lib/daily-report";
import { denyReason } from "@/lib/roles";
import { fmtDateTime, localToIso } from "@/lib/time";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/workflow";
import { cn } from "@/lib/utils";

function AddAppointment({ date }: { date: string }) {
  const { role } = useApp();
  const add = useAddAppointment();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<AppointmentKind>("meeting");
  const [time, setTime] = useState("10:00");
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  if (!open)
    return (
      <GatedButton reason={denyReason(role, "manage_appointments")} size="sm" variant="outline" onClick={() => setOpen(true)}>
        <CalendarPlus aria-hidden /> Add
      </GatedButton>
    );
  return (
    <form
      className="grid gap-2 rounded-xl border bg-muted/30 p-3 sm:grid-cols-[8rem_6rem_1fr]"
      onSubmit={(e) => {
        e.preventDefault();
        // The time is project-local (site time), whatever the device's own timezone is.
        add.mutate(
          { kind, title: title.trim(), starts_at: localToIso(`${date}T${time}`), location: location.trim() || null },
          { onSuccess: () => { setOpen(false); setTitle(""); setLocation(""); } },
        );
      }}
    >
      <label className="flex flex-col gap-1 text-xs font-medium">
        Type
        <select className="h-9 rounded-md border bg-background px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value as AppointmentKind)}>
          {APPOINTMENT_KINDS.map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Time
        <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        What
        <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} placeholder="e.g. Rebar inspection with the engineer" />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium sm:col-span-2">
        Where (optional)
        <Input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} />
      </label>
      <div className="flex items-end gap-2">
        <Button type="submit" size="sm" disabled={add.isPending || !title.trim()}>Save</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      {add.isError && <p className="text-xs text-red-800 sm:col-span-3">{add.error.message}</p>}
    </form>
  );
}

/** The day's appointments and site report draft (manager day view). */
export function DailyReportCard({ date, onOpenDraft }: { date: string; onOpenDraft: (id: string) => void }) {
  const { role } = useApp();
  const report = useDailyReport(date);
  const draft = useDraftDailyReport();
  const appointments = useAppointments(date);
  const extract = useExtractAppointments();
  const add = useAddAppointment();
  const cancel = useCancelAppointment();
  const existing = report.data;
  return (
    <section className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="daily-report-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="daily-report-title" className="flex items-center gap-2 text-base font-semibold">
            <FileText className="size-4 text-muted-foreground" aria-hidden /> Daily site report
          </h2>
          <p className="text-sm text-muted-foreground">
            Drafted from the day’s signed figures, notes, photos and appointments. Every line cites its record; you review and sign it.
          </p>
        </div>
        {existing && (
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset", STATUS_TONE[existing.status])}>
            {STATUS_LABEL[existing.status]} · v{existing.latest.version}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <GatedButton
          reason={denyReason(role, "draft_report")}
          size="sm"
          disabled={draft.isPending}
          onClick={() => draft.mutate(date, { onSuccess: (r) => onOpenDraft(r.draft.id) })}
        >
          <FileText aria-hidden /> {draft.isPending ? "Drafting…" : existing ? "Redraft from the latest records" : "Draft the report"}
        </GatedButton>
        {existing && (
          <Button size="sm" variant="outline" onClick={() => onOpenDraft(existing.id)}>
            Open the report
          </Button>
        )}
      </div>
      {draft.isError && <p className="text-sm text-red-800" role="alert">{draft.error.message}</p>}
      {draft.isSuccess && !draft.data.changed && <p className="text-xs text-muted-foreground">No new records since the last version.</p>}

      <div className="flex flex-col gap-2 border-t pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <CalendarClock className="size-4 text-muted-foreground" aria-hidden /> Appointments
          </h3>
          <div className="flex gap-2">
            <GatedButton reason={denyReason(role, "draft_report")} size="sm" variant="ghost" disabled={extract.isPending} onClick={() => extract.mutate(date)}>
              <Search aria-hidden /> Find in records
            </GatedButton>
            <AddAppointment date={date} />
          </div>
        </div>
        {appointments.isPending ? (
          <LoadingSkeleton rows={1} />
        ) : appointments.isError ? (
          <ErrorState error={appointments.error} onRetry={() => void appointments.refetch()} />
        ) : appointments.data.length ? (
          <ul className="flex flex-col gap-1.5">
            {appointments.data.map((a) => (
              <li key={a.id} className={cn("flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm", a.status === "cancelled" && "opacity-60 line-through")}>
                <span className="font-mono text-xs tabular-nums">{a.local_time}</span>
                <span className="rounded bg-muted px-1.5 text-xs">{KIND_LABEL[a.kind]}</span>
                <span className="min-w-0 flex-1">{a.title}{a.location ? ` · ${a.location}` : ""}</span>
                {a.source_id && a.locator && (
                  <CitationChip refData={{ source_id: a.source_id, locator: a.locator, passage_id: `${a.source_id}:${a.locator}` }} />
                )}
                {a.status !== "cancelled" && (
                  <GatedButton reason={denyReason(role, "manage_appointments")} size="sm" variant="ghost" aria-label={`Cancel ${a.title}`} disabled={cancel.isPending} onClick={() => cancel.mutate(a)}>
                    <X aria-hidden />
                  </GatedButton>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No appointments recorded for this day.</p>
        )}
        {extract.isError && <p className="text-xs text-red-800">{extract.error.message}</p>}
        {extract.isSuccess && (
          extract.data.proposals.length ? (
            <ul className="flex flex-col gap-1.5" aria-label="Proposed from the records">
              {extract.data.proposals.map((p) => (
                <li key={`${p.source_id}:${p.locator}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm">
                  <span className="font-mono text-xs">{fmtDateTime(p.starts_at)}</span>
                  <span className="min-w-0 flex-1">{p.title}</span>
                  <CitationChip refData={{ source_id: p.source_id, locator: p.locator, passage_id: `${p.source_id}:${p.locator}` }} />
                  <Button size="sm" variant="outline" disabled={add.isPending}
                    onClick={() => add.mutate({ kind: p.kind, title: p.title, starts_at: p.starts_at, source_id: p.source_id, locator: p.locator },
                      { onSuccess: () => extract.mutate(date) })}>
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing new found in the records for this day.</p>
          )
        )}
      </div>
    </section>
  );
}
