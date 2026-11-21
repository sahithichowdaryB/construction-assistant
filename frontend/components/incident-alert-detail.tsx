"use client";

import { Check, ClipboardList, FilePen, Pencil, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertStatusBadge, IncidentStatusBadge, SeverityBadge } from "@/components/badges";
import { CitationList } from "@/components/citation-chip";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useAlertDetail, useAlertTransition, useCategoryLabel, useCreateDraft, useDecideAction, useEditAction,
} from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";
import type { RecommendedAction, ActionStatus, ActionType } from "@/lib/types";
import { cn } from "@/lib/utils";

const ACTION_LABEL: Record<ActionType, string> = {
  assign_owner: "Assign owner",
  notify_contractor: "Notify contractor",
  schedule_repair: "Schedule repair",
  stop_work: "Stop work",
  isolate_area: "Isolate area",
  request_evidence: "Request evidence",
  draft_notice: "Draft notice",
  create_rfi: "Create RFI",
  resolve_incident: "Resolve incident",
};
const STATUS_CLS: Record<ActionStatus, string> = {
  proposed: "border-amber-300 bg-amber-50 text-amber-900",
  approved: "border-sky-300 bg-sky-50 text-sky-800",
  in_progress: "border-sky-300 bg-sky-50 text-sky-800",
  done: "border-emerald-300 bg-emerald-50 text-emerald-800",
  rejected: "border-border bg-muted text-muted-foreground",
  superseded: "border-border bg-muted text-muted-foreground",
};
const PRIORITY_CLS = { urgent: "text-red-700", high: "text-red-700", medium: "text-amber-800", low: "text-muted-foreground" } as const;
const ANALYSIS_LABEL = {
  established: "Established", probable: "Probable", unconfirmed: "Unconfirmed", undetermined: "Cause unknown", needs_review: "Needs review",
} as const;

function ActionRow({ alertId, incidentId, action }: { alertId: string; incidentId: string | null; action: RecommendedAction }) {
  const { role } = useApp();
  const router = useRouter();
  const decide = useDecideAction(alertId);
  const edit = useEditAction(alertId);
  const draft = useCreateDraft();
  const gate = denyReason(role, "approve_action");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: action.title, rationale: action.rationale ?? "", owner_role: action.owner_role ?? "", priority: action.priority ?? "medium" });
  const act = (decision: "approve" | "reject" | "complete") => decide.mutate({ actionId: action.id, decision });
  const live = action.status === "proposed" || action.status === "approved" || action.status === "in_progress";

  return (
    <li className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-md border px-1.5 py-0.5 text-xs font-medium", STATUS_CLS[action.status])}>{action.status.replace("_", " ")}</span>
        <span className="text-xs font-medium text-muted-foreground">{ACTION_LABEL[action.action_type]}</span>
        {action.priority && <span className={cn("text-xs font-semibold uppercase", PRIORITY_CLS[action.priority])}>{action.priority}</span>}
        {action.owner_role && <span className="text-xs text-muted-foreground">Owner: {action.owner_role.replace(/_/g, " ")}</span>}
        {action.due_at && <span className="text-xs text-muted-foreground">Due {fmtDateTime(action.due_at)}</span>}
      </div>
      <p className="font-medium">{action.title}</p>
      {action.rationale && <p className="text-muted-foreground">{action.rationale}</p>}
      <CitationList refs={action.evidence_refs} />
      {action.result && action.status !== "proposed" && (
        <p className="text-xs text-muted-foreground">
          {"assigned_to" in action.result && `Assigned to ${String(action.result.assigned_to)}. `}
          {"notified" in action.result && action.result.notified != null && `${String(action.result.notified)} noted (not sent automatically). `}
          {"capture_prompt" in action.result && "Shown on the Capture page until marked done."}
        </p>
      )}
      {live && (
        <div className="flex flex-wrap gap-2">
          {action.status === "proposed" && (
            <GatedButton reason={gate} size="sm" disabled={decide.isPending} onClick={() => act("approve")}>
              <Check aria-hidden /> Approve
            </GatedButton>
          )}
          {action.action_type === "draft_notice" && (action.status === "approved" || action.status === "in_progress") && (
            <Button
              size="sm"
              disabled={draft.isPending}
              onClick={() => draft.mutate({ type: "delay", alert_id: alertId, incident_id: incidentId }, { onSuccess: (d) => router.push(`/drafts/${d.id}`) })}
            >
              <FilePen aria-hidden /> Open draft
            </Button>
          )}
          {action.status !== "proposed" && (
            <GatedButton reason={gate} size="sm" variant="outline" disabled={decide.isPending} onClick={() => act("complete")}>
              Mark done
            </GatedButton>
          )}
          <GatedButton reason={gate} size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil aria-hidden /> Edit
          </GatedButton>
          <GatedButton reason={gate} size="sm" variant="ghost" disabled={decide.isPending} onClick={() => act("reject")}>
            <X aria-hidden /> Reject
          </GatedButton>
        </div>
      )}
      {decide.isError && <ErrorState error={decide.error} />}
      {draft.isError && <ErrorState error={draft.error} />}
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit action</DialogTitle>
            <DialogDescription>Changes are logged on the alert.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              edit.mutate(
                { actionId: action.id, patch: { title: form.title, rationale: form.rationale, owner_role: form.owner_role || undefined, priority: form.priority } },
                { onSuccess: () => setEditing(false) },
              );
            }}
          >
            <Label htmlFor={`t-${action.id}`}>Title</Label>
            <Input id={`t-${action.id}`} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required minLength={3} />
            <Label htmlFor={`r-${action.id}`}>Why</Label>
            <Textarea id={`r-${action.id}`} rows={3} value={form.rationale} onChange={(e) => setForm({ ...form, rationale: e.target.value })} />
            <Label htmlFor={`o-${action.id}`}>Owner role</Label>
            <Input id={`o-${action.id}`} value={form.owner_role} onChange={(e) => setForm({ ...form, owner_role: e.target.value })} placeholder="site_manager" />
            <Label htmlFor={`p-${action.id}`}>Priority</Label>
            <select id={`p-${action.id}`} className="h-9 rounded-md border bg-background px-2 text-sm" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as typeof form.priority })}>
              {["low", "medium", "high", "urgent"].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            {edit.isError && <ErrorState error={edit.error} />}
            <DialogFooter>
              <Button type="submit" size="touch" disabled={edit.isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** Alert detail for an incident alert: likely cause, recommended actions a manager can enact, history. */
export function IncidentAlertDetail({ id }: { id: string }) {
  const { role } = useApp();
  const detail = useAlertDetail(id);
  const transition = useAlertTransition(id);
  const categoryLabel = useCategoryLabel();
  const gate = denyReason(role, "act_on_alert");
  const [dialog, setDialog] = useState<null | "assign" | "resolve" | "dismiss">(null);
  const [text, setText] = useState("");
  const [alsoIncident, setAlsoIncident] = useState(true);

  if (detail.isPending) return <LoadingSkeleton variant="detail" rows={3} />;
  if (detail.isError) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  const a = detail.data;
  const inc = a.incident;
  const submit = () => {
    if (!dialog) return;
    transition.mutate(
      dialog === "assign" ? { action: "assign", assignee: text } : dialog === "dismiss" ? { action: "dismiss", note: text } : { action: "resolve", note: text || undefined, resolve_incident: alsoIncident },
      { onSuccess: () => { setDialog(null); setText(""); } },
    );
  };
  const quick = (action: "ack" | "reopen") => transition.mutate({ action });
  const open = a.status === "open" || a.status === "acknowledged" || a.status === "in_progress";
  const proposed = a.actions.filter((x) => x.status === "proposed").length;

  return (
    <>
      <PageHeader
        title={a.title ?? inc?.summary ?? "Incident alert"}
        description={`${inc ? `${categoryLabel(inc.category)} · ${inc.report_count} report${inc.report_count === 1 ? "" : "s"} from ${inc.reporter_count} ${inc.reporter_count === 1 ? "person" : "people"}` : ""}${a.assigned_to ? ` · assigned to ${a.assigned_to}` : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {inc?.severity && <SeverityBadge severity={inc.severity} className="text-sm" />}
            <AlertStatusBadge status={a.status} className="text-sm" />
            {inc && <IncidentStatusBadge status={inc.status} className="text-sm" />}
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {a.status === "open" && <GatedButton reason={gate} size="touch" disabled={transition.isPending} onClick={() => quick("ack")}>Acknowledge</GatedButton>}
        {open && <GatedButton reason={gate} size="touch" variant="outline" onClick={() => setDialog("assign")}>Assign</GatedButton>}
        {open && <GatedButton reason={gate} size="touch" variant="outline" onClick={() => setDialog("resolve")}>Resolve</GatedButton>}
        {open && <GatedButton reason={gate} size="touch" variant="outline" onClick={() => setDialog("dismiss")}>Dismiss (reason)</GatedButton>}
        {!open && <GatedButton reason={gate} size="touch" variant="outline" disabled={transition.isPending} onClick={() => quick("reopen")}>Reopen</GatedButton>}
        {a.incident_id && (
          <Button size="touch" variant="ghost" asChild>
            <Link href={`/incidents/${a.incident_id}`}>View incident and its sources</Link>
          </Button>
        )}
      </div>
      {transition.isError && <ErrorState error={transition.error} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Likely cause</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              {a.analysis ? (
                <>
                  <p className="font-medium">
                    {a.analysis.headline_cause ?? "No cause has been established from the records."}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {ANALYSIS_LABEL[a.analysis.status]} · confidence {Math.round(a.analysis.confidence * 100)}% · analysis v{a.analysis.version}, {fmtDateTime(a.analysis.as_of)}
                  </p>
                  <p className="text-muted-foreground">{a.analysis.reasoning}</p>
                  {a.analysis.gaps.length > 0 && (
                    <ul className="list-disc pl-5 text-muted-foreground">
                      {a.analysis.gaps.map((g) => <li key={g}>{g}</li>)}
                    </ul>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground">Analysing the reports… the likely cause appears here within a minute or two of the last report.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ClipboardList className="size-4" aria-hidden /> Recommended actions {proposed > 0 && <span className="text-sm font-normal text-muted-foreground">({proposed} to review)</span>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {a.actions.length ? (
                <ul className="flex flex-col gap-3">
                  {a.actions.map((x) => <ActionRow key={x.id} alertId={a.id} incidentId={a.incident_id} action={x} />)}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Actions are proposed once the likely cause has been analysed. Nothing happens until a manager approves it.</p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent>
              {a.activity.length ? (
                <ol className="flex flex-col gap-2 text-sm">
                  {a.activity.map((x) => (
                    <li key={x.id}>
                      <span className="font-medium">{x.actor}</span> {x.action.replace(/_/g, " ")}
                      {x.to_status && <span className="text-muted-foreground"> → {x.to_status.replace("_", " ")}</span>}
                      {x.note && <span className="block text-xs text-muted-foreground">{x.note}</span>}
                      <span className="block text-xs text-muted-foreground">{fmtDateTime(x.at)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">No manager activity yet.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Revisions</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="flex flex-col gap-2 text-sm">
                {a.revisions.map((r) => (
                  <li key={r.version} className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={r.severity} />
                    <span className="text-xs text-muted-foreground">v{r.version} · {fmtDateTime(r.as_of)}</span>
                    {r.reason && <span className="w-full text-xs text-muted-foreground">{r.reason}</span>}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog === "assign" ? "Assign alert" : dialog === "dismiss" ? "Dismiss alert" : "Resolve alert"}</DialogTitle>
            <DialogDescription>
              {dialog === "dismiss" ? "A reason is required and kept with the alert history." : dialog === "assign" ? "Who is looking after this?" : "Optionally add a note."}
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <Label htmlFor="alert-dialog-text">{dialog === "assign" ? "Assignee" : dialog === "dismiss" ? "Reason" : "Note"}</Label>
            <Textarea id="alert-dialog-text" rows={dialog === "assign" ? 1 : 3} value={text} onChange={(e) => setText(e.target.value)} required={dialog !== "resolve"} />
            {dialog === "resolve" && a.incident_id && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={alsoIncident} onChange={(e) => setAlsoIncident(e.target.checked)} /> Also resolve the incident
              </label>
            )}
            <DialogFooter>
              <Button type="submit" size="touch" disabled={transition.isPending || (dialog !== "resolve" && !text.trim())}>
                Confirm
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
