"use client";

import { Calculator, Save, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useIdentity } from "@/components/account-menu";
import { ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useExampleRates, useRates, useSaveRates } from "@/lib/correspondence";
import { fmtDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";

const UNIT_LABEL: Record<string, string> = { "worker-hour": "per worker-hour", hour: "per hour", day: "per day" };

/**
 * The project's rate table for cost notices. The list of rates comes from the project: labour,
 * overhead and one standby rate per machine in the equipment register. Only the site manager edits.
 */
export function CostRatesCard() {
  const identity = useIdentity();
  const canEdit = identity.memberRole === "site_manager";
  const rates = useRates();
  const save = useSaveRates();
  const examples = useExampleRates();
  const [values, setValues] = useState<Record<string, string>>({});
  const [currency, setCurrency] = useState("EUR");
  const [shift, setShift] = useState({ start: "07:00", end: "17:30" });

  useEffect(() => {
    if (!rates.data) return;
    setValues(Object.fromEntries(rates.data.rates.map((r) => [r.key, r.amount === null ? "" : String(r.amount)])));
    setCurrency(rates.data.currency);
    setShift({ start: rates.data.shift_start, end: rates.data.shift_end });
  }, [rates.data]);

  const dirty =
    !!rates.data &&
    (currency !== rates.data.currency ||
      shift.start !== rates.data.shift_start ||
      shift.end !== rates.data.shift_end ||
      rates.data.rates.some((r) => (r.amount === null ? "" : String(r.amount)) !== (values[r.key] ?? "")));
  const examplesInUse = rates.data?.rates.filter((r) => r.is_example).length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calculator className="size-4 text-muted-foreground" aria-hidden /> Cost rates
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Used for cost notices written with SiteMate. Costs are calculated from these rates only; a missing rate stays missing in the letter.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rates.isPending ? (
          <LoadingSkeleton rows={4} />
        ) : rates.isError ? (
          <ErrorState error={rates.error} onRetry={() => void rates.refetch()} />
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate({
                currency,
                shift_start: shift.start,
                shift_end: shift.end,
                rates: rates.data.rates.map((r) => ({ key: r.key, amount: values[r.key] === "" ? null : Number(values[r.key]) })),
              });
            }}
          >
            {examplesInUse > 0 && (
              <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                {examplesInUse} rate{examplesInUse === 1 ? " is an example" : "s are examples"}. Letters that use them cannot be approved until you save
                real rates here.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="currency">Currency</Label>
                <Input id="currency" value={currency} maxLength={3} disabled={!canEdit} onChange={(e) => setCurrency(e.target.value.toUpperCase())} className="h-11 md:h-9" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="shift-start">Working day starts</Label>
                <Input id="shift-start" type="time" value={shift.start} disabled={!canEdit} onChange={(e) => setShift((s) => ({ ...s, start: e.target.value }))} className="h-11 md:h-9" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="shift-end">Working day ends</Label>
                <Input id="shift-end" type="time" value={shift.end} disabled={!canEdit} onChange={(e) => setShift((s) => ({ ...s, end: e.target.value }))} className="h-11 md:h-9" />
              </div>
            </div>
            <ul className="divide-y rounded-xl border">
              {rates.data.rates.map((r) => (
                <li key={r.key} className="grid items-center gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_10rem]">
                  <span className="min-w-0 text-sm">
                    <span className="block font-medium">{r.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {UNIT_LABEL[r.unit] ?? r.unit}
                      {r.updated_at && !r.is_example ? ` · saved ${fmtDateTime(r.updated_at)}` : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Input
                      aria-label={`${r.label} in ${currency}`}
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      disabled={!canEdit}
                      value={values[r.key] ?? ""}
                      placeholder="Not set"
                      onChange={(e) => setValues((v) => ({ ...v, [r.key]: e.target.value }))}
                      className={cn("h-11 text-right tabular-nums md:h-9", r.is_example && "border-amber-300 bg-amber-50/60")}
                    />
                    {r.is_example && <span className="rounded bg-amber-100 px-1.5 text-[11px] text-amber-900">example</span>}
                  </span>
                </li>
              ))}
            </ul>
            {canEdit ? (
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!dirty || save.isPending}>
                  <Save aria-hidden /> {save.isPending ? "Saving…" : "Save rates"}
                </Button>
                {rates.data.rates.some((r) => r.amount === null) && (
                  <Button type="button" variant="outline" disabled={examples.isPending} onClick={() => examples.mutate()}>
                    <Sparkles aria-hidden /> Fill empty rates with example values (demo)
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Only the site manager can change the rates.</p>
            )}
            {(save.isError || examples.isError) && <ErrorState error={save.error ?? examples.error} />}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
