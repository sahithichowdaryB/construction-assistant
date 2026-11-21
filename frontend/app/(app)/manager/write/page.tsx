"use client";

import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  ChevronDown,
  Clock3,
  ListTodo,
  Mail,
  MessageSquareWarning,
  PenLine,
  Plus,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  Target,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { CitationChip } from "@/components/citation-chip";
import { GatedButton } from "@/components/gated-button";
import { NoticeDownloads } from "@/components/notice-downloads";
import { NoticeText } from "@/components/notice-text";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  money,
  useCorrespondence,
  useCorrespondenceList,
  useCreateDraft,
  useRegenerate,
  useSaveEdit,
  useSubmitDraft,
  useWriterOptions,
  type Analysis,
  type Correspondence,
  type Kind,
} from "@/lib/correspondence";
import { denyReason } from "@/lib/roles";
import { fmtDateTime, fmtLocalDate, localDateOf } from "@/lib/time";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/workflow";

const TOP = 5;
const BASIS_LABEL: Record<string, string> = {
  "your request": "your text",
  "equipment register": "register",
  programme: "programme",
};
const SOURCE_LABEL: Record<string, string> = {
  record: "Record",
  calculated: "Calculated",
  "your request": "Your text",
  document: "Document",
};
const REGENERATE_HINTS = ["Firmer", "Shorter", "More detail", "Friendlier"];

function Pill({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset", className)}>{children}</span>;
}

// ------------------------------------------------------------------ request form

function RequestForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { role, asOf } = useApp();
  const options = useWriterOptions();
  const create = useCreateDraft();
  const clockDay = localDateOf(asOf);
  const [what, setWhat] = useState("");
  const [kind, setKind] = useState<Kind>("email");
  const [recipient, setRecipient] = useState("suggest");
  const [emphasis, setEmphasis] = useState("");
  const [day, setDay] = useState("");
  const blocked = denyReason(role, "create_draft");

  if (options.isPending) return <LoadingSkeleton variant="cards" rows={2} />;
  if (options.isError) return <ErrorState error={options.error} onRetry={() => void options.refetch()} />;
  const chosen = options.data.kinds.find((k) => k.key === kind);
  const rates = options.data.rates;

  return (
    <form
      className="flex w-full flex-col gap-5 rounded-2xl border bg-card p-5 shadow-xs sm:p-6"
      onSubmit={(e) => {
        e.preventDefault();
        const pick = options.data.recipients.find((r) => `${r.type}:${r.id}` === recipient);
        create.mutate(
          {
            what_happened: what.trim(),
            kind,
            recipient: pick ? { type: pick.type, id: pick.type === "contractor" ? pick.id : undefined } : null,
            emphasis: emphasis.trim() || null,
            work_date: day || null,
          },
          { onSuccess: (d) => onCreated(d.draft.id) },
        );
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="what" className="text-sm font-semibold">
          What happened?
        </Label>
        <Textarea
          id="what"
          rows={4}
          maxLength={3000}
          value={what}
          onChange={(e) => setWhat(e.target.value)}
          placeholder="What happened, when, who or what is affected, who is responsible"
          className="min-h-28 text-base"
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">What should it be?</span>
        <div role="radiogroup" aria-label="Type" className="flex flex-wrap gap-1.5">
          {options.data.kinds.map((k) => (
            <button
              key={k.key}
              type="button"
              role="radio"
              aria-checked={kind === k.key}
              onClick={() => setKind(k.key)}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors",
                kind === k.key ? "border-foreground bg-foreground text-background" : "bg-background hover:bg-muted",
              )}
            >
              {k.formal ? <PenLine className="size-3.5" aria-hidden /> : <Mail className="size-3.5" aria-hidden />}
              {k.label}
            </button>
          ))}
        </div>
        {chosen && <p className="text-xs text-muted-foreground">{chosen.description}</p>}
        {chosen?.uses_costs && rates.set < rates.total && (
          <p className="flex items-center gap-1.5 text-xs text-amber-900">
            <Calculator className="size-3.5" aria-hidden /> {rates.total - rates.set} rate{rates.total - rates.set === 1 ? "" : "s"} not set.{" "}
            <Link href="/settings" className="font-medium underline">
              Set rates
            </Link>
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="recipient" className="text-sm font-semibold">
            To whom?
          </Label>
          <Select value={recipient} onValueChange={setRecipient}>
            <SelectTrigger id="recipient" className="h-11 w-full md:h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="suggest">Let SiteMate suggest</SelectItem>
              {options.data.recipients.map((r) => (
                <SelectItem key={`${r.type}:${r.id}`} value={`${r.type}:${r.id}`}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="day" className="text-sm font-semibold">
            Day
          </Label>
          <Input id="day" type="date" max={clockDay} value={day || clockDay} onChange={(e) => setDay(e.target.value)} className="h-11 md:h-10" />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="emphasis" className="text-sm font-semibold">
          Anything to stress? <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="emphasis"
          maxLength={1000}
          value={emphasis}
          onChange={(e) => setEmphasis(e.target.value)}
          placeholder="e.g. ask for a replacement machine by tomorrow 07:00"
          className="h-11 md:h-10"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock3 className="size-3.5" aria-hidden /> Records as of {fmtDateTime(asOf)} · nothing is sent
        </p>
        <GatedButton type="submit" reason={blocked} size="touch" disabled={what.trim().length < 5 || create.isPending}>
          <Sparkles aria-hidden /> {create.isPending ? "Writing… (20–40 s)" : "Create draft"}
        </GatedButton>
      </div>
      {create.isError && <ErrorState error={create.error} />}
    </form>
  );
}

// ------------------------------------------------------------------ insight panel

function Stat({ icon, label, value, tone }: { icon: ReactNode; label: string; value: ReactNode; tone?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 rounded-xl border bg-background p-3", tone)}>
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground [&_svg]:size-3.5">
        {icon} {label}
      </span>
      <span className="truncate text-sm font-semibold">{value}</span>
    </div>
  );
}

function ShowMore<T>({ items, render, empty }: { items: T[]; render: (item: T) => ReactNode; empty: string }) {
  const [all, setAll] = useState(false);
  if (!items.length) return <p className="py-2 text-sm text-muted-foreground">{empty}</p>;
  const shown = all ? items : items.slice(0, TOP);
  return (
    <div className="flex flex-col gap-2">
      <ul className="grid gap-2 md:grid-cols-2">{shown.map(render)}</ul>
      {items.length > TOP && (
        <button type="button" onClick={() => setAll((v) => !v)} className="self-start text-xs font-medium underline underline-offset-2">
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

function Insights({ a }: { a: Analysis }) {
  const overdue = a.actions.filter((x) => x.overdue).length;
  const records = a.facts.filter((f) => f.source !== "calculated");
  const removed = a.removed ?? [];
  const u = a.understood;
  const understood: [string, string | null, string | undefined][] = [
    ["Machine", u.equipment_ids.join(", ") || null, u.basis.equipment_ids],
    ["Time", u.occurred_local_time, u.basis.occurred_local_time],
    ["People", u.workers_affected !== null ? String(u.workers_affected) : null, u.basis.workers_affected],
    ["Responsible", a.responsible?.name ?? null, u.basis.responsible_contractor_id],
  ];

  return (
    <section className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-xs" aria-label="What SiteMate found">
      <h2 className="text-base font-semibold">What SiteMate found</h2>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat icon={<Target />} label="Work" value={a.activity ? `${a.activity.code} · ${a.activity.name}` : "Not identified"} />
        <Stat icon={<Clock3 />} label="Time lost" value={a.timeline ? `${a.timeline.working_hours} h${a.timeline.resolved ? "" : " (ongoing)"}` : "Unknown"} />
        <Stat
          icon={<Calculator />}
          label="Cost so far"
          value={a.costs.lines.length ? `${money(a.costs.total, a.costs.currency)}${a.costs.complete ? "" : "+"}` : "No rates used"}
        />
        <Stat
          icon={<ListTodo />}
          label="Overdue actions"
          value={overdue ? `${overdue} overdue` : "None"}
          tone={overdue ? "border-red-200 bg-red-50 text-red-900" : undefined}
        />
      </div>

      <dl className="grid grid-cols-2 gap-3 rounded-xl bg-muted/40 p-3 text-sm md:grid-cols-4">
        {understood.map(([label, value, basis]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className={cn("font-medium break-words", !value && "text-muted-foreground")}>
              {value ?? "—"}
              {value && basis && <span className="block text-xs font-normal text-muted-foreground">from {BASIS_LABEL[basis] ?? basis}</span>}
            </dd>
          </div>
        ))}
      </dl>

      <Tabs defaultValue="facts" className="gap-3">
        <TabsList variant="line" className="w-full justify-start gap-0 border-b">
          <TabsTrigger value="facts" className="flex-none px-3 pb-2 text-sm">
            Facts <span className="text-muted-foreground">{records.length}</span>
          </TabsTrigger>
          <TabsTrigger value="costs" className="flex-none px-3 pb-2 text-sm">
            Costs
          </TabsTrigger>
          <TabsTrigger value="actions" className="flex-none px-3 pb-2 text-sm">
            Actions <span className="text-muted-foreground">{a.actions.length}</span>
          </TabsTrigger>
          <TabsTrigger value="checks" className="flex-none px-3 pb-2 text-sm">
            Checks {removed.length > 0 && <span className="text-amber-700">{removed.length}</span>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="facts">
          <ShowMore
            items={records}
            empty="No records were found."
            render={(f) => (
              <li key={f.id} className="flex flex-col gap-1 rounded-lg border p-2.5 text-xs">
                <span className="line-clamp-3 leading-relaxed text-foreground">{f.text}</span>
                <span className="flex flex-wrap items-center gap-1">
                  <span className="text-muted-foreground">{SOURCE_LABEL[f.source]}</span>
                  {f.untrusted && <Pill className="bg-amber-50 text-amber-900 ring-amber-200">external</Pill>}
                  {f.refs.slice(0, 2).map((r) => (
                    <CitationChip key={r.passage_id} refData={r} />
                  ))}
                  {f.refs.length > 2 && <span className="text-muted-foreground">+{f.refs.length - 2}</span>}
                </span>
              </li>
            )}
          />
        </TabsContent>

        <TabsContent value="costs">
          {a.costs.lines.length ? (
            <div className="flex flex-col gap-2">
              <ul className="divide-y rounded-lg border text-xs">
                {a.costs.lines.map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-2 px-2.5 py-2">
                    <span className="min-w-0 truncate">{c.label}</span>
                    <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
                      {c.amount === null ? <Pill className="bg-red-50 text-red-800 ring-red-200">rate missing</Pill> : <strong>{money(c.amount, a.costs.currency)}</strong>}
                      {c.is_example && <Pill className="bg-amber-50 text-amber-900 ring-amber-200">example</Pill>}
                    </span>
                  </li>
                ))}
                <li className="flex justify-between px-2.5 py-2 font-semibold">
                  <span>Total{a.costs.complete ? "" : " (known rates)"}</span>
                  <span className="tabular-nums">{money(a.costs.total, a.costs.currency)}</span>
                </li>
              </ul>
              {a.timeline && (
                <p className="text-[11px] text-muted-foreground">
                  {fmtDateTime(a.timeline.start)} → {fmtDateTime(a.timeline.end)} · working day {a.timeline.shift}
                </p>
              )}
              <Link href="/settings" className="text-xs underline underline-offset-2">
                Edit rates
              </Link>
            </div>
          ) : (
            <p className="py-2 text-sm text-muted-foreground">No standing time or rates were needed for this draft.</p>
          )}
        </TabsContent>

        <TabsContent value="actions">
          <ShowMore
            items={a.actions}
            empty="No open agreed actions concern this."
            render={(x) => (
              <li key={x.id} className="flex flex-col gap-1 rounded-lg border p-2.5 text-xs">
                <span className="line-clamp-2">
                  {x.owner && <strong>{x.owner}: </strong>}
                  {x.description}
                </span>
                <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                  {x.overdue && <Pill className="bg-red-50 text-red-800 ring-red-200">Overdue</Pill>}
                  {x.due_at ? `Due ${fmtDateTime(x.due_at)}` : "No due date"}
                  {x.ref && <CitationChip refData={x.ref} />}
                </span>
              </li>
            )}
          />
        </TabsContent>

        <TabsContent value="checks">
          {removed.length ? (
            <ShowMore
              items={removed}
              empty=""
              render={(r) => (
                <li key={r.text} className="rounded-lg border border-dashed p-2.5 text-xs">
                  <span className="line-clamp-2 line-through decoration-red-400">{r.text}</span>
                  <span className="mt-1 block text-muted-foreground">{r.reason}</span>
                </li>
              )}
            />
          ) : (
            <p className="flex items-center gap-1.5 py-2 text-sm text-emerald-800">
              <CheckCircle2 className="size-4" aria-hidden /> Every number matched the records.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}

// ------------------------------------------------------------------ the draft

function Workspace({ item }: { item: Correspondence }) {
  const { role } = useApp();
  const regenerate = useRegenerate();
  const submit = useSubmitDraft();
  const save = useSaveEdit();
  const [editing, setEditing] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [text, setText] = useState(item.draft.latest.body);
  const [instruction, setInstruction] = useState("");
  const d = item.draft;
  const review = d.latest.review;
  const locked = d.status === "approved";
  const busy = regenerate.isPending || submit.isPending || save.isPending;
  const missing = d.latest.missing_fields;

  return (
    <div className="flex flex-col gap-5">
      <section className="flex min-w-0 flex-col gap-4 rounded-2xl border bg-card p-5 shadow-xs sm:p-6">
        {/* header */}
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-semibold tracking-wide uppercase">{d.kind_label}</span>
            <span aria-hidden>·</span>
            <span>v{d.latest.version}</span>
            <Pill className={cn("ml-auto", STATUS_TONE[d.status])}>{STATUS_LABEL[d.status]}</Pill>
          </div>
          <h2 className="text-lg leading-snug font-semibold">{d.title}</h2>
          <p className="text-sm text-muted-foreground">
            To <span className="text-foreground">{item.recipient_label}</span>
            {item.recipient.chosen_by === "agent" && <span className="text-xs"> · suggested</span>}
          </p>
          <details className="group text-xs text-muted-foreground">
            <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-foreground">
              <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden /> Your request · {fmtLocalDate(item.analysis.day)}
            </summary>
            <p className="mt-2 rounded-lg bg-muted/50 px-3 py-2 text-foreground">“{item.request.what_happened}”</p>
            {item.request.emphasis && <p className="mt-1">Stress: {item.request.emphasis}</p>}
            {item.analysis.instruction && <p className="mt-1">Last instruction: “{item.analysis.instruction}”</p>}
          </details>
        </header>

        {/* one status message at most */}
        {review?.decision === "changes_requested" ? (
          <p className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            <MessageSquareWarning className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              <strong>{review.reviewer}:</strong> “{review.reason}”
            </span>
          </p>
        ) : locked && review ? (
          <p className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            <CheckCircle2 className="size-4" aria-hidden /> Approved by {review.reviewer} · {fmtDateTime(review.decided_at)}
          </p>
        ) : missing.length ? (
          <p className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Fill in before approval: <strong>{missing.join(", ")}</strong>
            </span>
          </p>
        ) : null}

        {/* toolbar */}
        {!locked && !editing && (
          <div className="flex flex-wrap items-center gap-2 border-y py-3">
            {d.status === "draft" && (
              <GatedButton reason={denyReason(role, "submit_review")} disabled={busy} onClick={() => submit.mutate(d.id)}>
                <Send aria-hidden /> {submit.isPending ? "Sending…" : "Send for approval"}
              </GatedButton>
            )}
            <Button variant="outline" disabled={busy} onClick={() => { setText(d.latest.body); setEditing(true); }}>
              <PenLine aria-hidden /> Edit
            </Button>
            <Button variant="outline" disabled={busy} aria-expanded={rewriting} onClick={() => setRewriting((v) => !v)}>
              <RefreshCw aria-hidden className={regenerate.isPending ? "animate-spin" : undefined} /> {regenerate.isPending ? "Writing…" : "Regenerate"}
            </Button>
          </div>
        )}

        {rewriting && !locked && !editing && (
          <form
            className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              regenerate.mutate({ id: d.id, instruction }, { onSuccess: () => { setInstruction(""); setRewriting(false); } });
            }}
          >
            <div className="flex flex-wrap gap-1.5">
              {[...(review?.decision === "changes_requested" && review.reason ? ["Approver's request"] : []), ...REGENERATE_HINTS].map((hint) => (
                <button
                  key={hint}
                  type="button"
                  onClick={() => setInstruction(hint === "Approver's request" ? review?.reason ?? "" : `Make it ${hint.toLowerCase()}`)}
                  className="rounded-full border bg-background px-3 py-1 text-xs hover:bg-muted"
                >
                  {hint}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={500} placeholder="What should change? (optional)" className="h-10 flex-1 bg-background" />
              <Button type="submit" disabled={busy}>
                {regenerate.isPending ? "Writing…" : "Rewrite"}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">Uses the latest records at the clock time. Creates a new version.</p>
          </form>
        )}

        {/* the letter */}
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={22} className="font-mono text-[13px] leading-relaxed" />
            <p className="text-xs text-muted-foreground">Keep the [SOURCE · locator] tags; replace each [MISSING: …] with the real detail.</p>
            <div className="flex gap-2">
              <Button disabled={busy || text === d.latest.body} onClick={() => save.mutate({ id: d.id, body: text, expected_version: d.latest.version }, { onSuccess: () => setEditing(false) })}>
                <Save aria-hidden /> {save.isPending ? "Saving…" : `Save as v${d.latest.version + 1}`}
              </Button>
              <Button variant="ghost" onClick={() => { setEditing(false); setText(d.latest.body); }}>
                Cancel
              </Button>
            </div>
            {save.isError && <ErrorState error={save.error} />}
          </div>
        ) : (
          <NoticeText body={d.latest.body} className="max-h-[70vh] overflow-y-auto" />
        )}

        <NoticeDownloads notice={d} />
        {(submit.isError || regenerate.isError) && <ErrorState error={submit.error ?? regenerate.error} />}
      </section>

      <Insights a={item.analysis} />
    </div>
  );
}

// ------------------------------------------------------------------ drafts grid

type DraftItem = ReturnType<typeof useCorrespondenceList>["data"] extends (infer T)[] | undefined ? T : never;
const GRID_TOP = 4;
const DOT: Record<string, string> = {
  draft: "bg-muted-foreground/60",
  awaiting_review: "bg-amber-500",
  changes_requested: "bg-red-500",
  approved: "bg-emerald-500",
};

/** Even cards that wrap (no sideways scrolling); the newest four first, the rest on request. */
function DraftGrid({
  drafts,
  pending,
  error,
  onRetry,
  selected,
  onSelect,
}: {
  drafts: DraftItem[];
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [all, setAll] = useState(false);
  if (pending) return <LoadingSkeleton rows={1} />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!drafts.length) return null;
  let shown = all ? drafts : drafts.slice(0, GRID_TOP);
  const picked = drafts.find((d) => d.id === selected);
  if (picked && !shown.includes(picked)) shown = [...shown.slice(0, GRID_TOP - 1), picked];

  return (
    <section aria-label="Your drafts" className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Your drafts <span className="tabular-nums">({drafts.length})</span>
        </h2>
        {drafts.length > GRID_TOP && (
          <button type="button" onClick={() => setAll((v) => !v)} className="text-xs font-medium underline underline-offset-2">
            {all ? "Show fewer" : `Show all (${drafts.length})`}
          </button>
        )}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {shown.map((d) => (
          <li key={d.id} className="min-w-0">
            <button
              type="button"
              aria-current={d.id === selected ? "true" : undefined}
              onClick={() => onSelect(d.id)}
              className={cn(
                "flex h-full w-full flex-col gap-1.5 rounded-xl border bg-card px-3.5 py-3 text-left shadow-xs transition-colors hover:border-foreground/30",
                d.id === selected && "border-primary bg-primary/5 ring-1 ring-primary",
              )}
            >
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={cn("size-2 shrink-0 rounded-full", DOT[d.status])} aria-hidden />
                <span className="truncate font-medium">{STATUS_LABEL[d.status]}</span>
                <span className="ml-auto shrink-0">
                  {d.kind_label} · v{d.version}
                </span>
              </span>
              <span className="line-clamp-2 text-sm leading-snug font-semibold">{d.subject ?? d.kind_label}</span>
              <span className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
                <span className="truncate">To {d.recipient_label}</span>
                {!!d.missing && <span className="ml-auto shrink-0 font-semibold text-red-700">{d.missing} missing</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ page

export default function WritePage() {
  const list = useCorrespondenceList();
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { setSelected(new URLSearchParams(window.location.search).get("draft")); }, []);
  const item = useCorrespondence(selected);
  const drafts = list.data ?? [];

  return (
    <>
      <PageHeader
        title="Write with SiteMate"
        description="Describe the situation; SiteMate checks the records and drafts the email or letter for your review."
        actions={
          <Button onClick={() => setSelected(null)} variant={selected ? "default" : "outline"} disabled={!selected}>
            <Plus aria-hidden /> New draft
          </Button>
        }
      />

      <div className="flex flex-col gap-5">
        {/* Row 1: the drafts, full width */}
        <DraftGrid drafts={drafts} pending={list.isPending} error={list.isError ? list.error : null} onRetry={() => void list.refetch()}
          selected={selected} onSelect={setSelected} />

        {/* Row 2 and below: the form, or the letter and what SiteMate found */}
        <div className="min-w-0">
          {!selected ? (
            <RequestForm onCreated={setSelected} />
          ) : item.isPending ? (
            <LoadingSkeleton variant="cards" rows={2} />
          ) : item.isError ? (
            <ErrorState error={item.error} onRetry={() => void item.refetch()} />
          ) : item.data ? (
            <Workspace key={`${item.data.draft.id}-${item.data.draft.latest.version}`} item={item.data} />
          ) : (
            <EmptyState title="Draft not found" />
          )}
        </div>
      </div>
    </>
  );
}
