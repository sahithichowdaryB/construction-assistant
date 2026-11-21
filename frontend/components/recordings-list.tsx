"use client";

import { useQuery } from "@tanstack/react-query";
import { Keyboard, Mic } from "lucide-react";
import { RecordingAudio } from "@/components/recording-audio";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listRecordings, recordingAudioUrl, type SavedRecording } from "@/lib/agent";

export const RECORDINGS_KEY = (projectId: string) => ["agent-recordings", projectId] as const;

const label = (s: string) => s.replace(/_/g, " ");
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Analysis({ rec }: { rec: SavedRecording }) {
  return (
    <details className="rounded-2xl bg-muted/50 p-4 text-sm">
      <summary className="cursor-pointer font-semibold">
        Analysis · {rec.facts.length} fact{rec.facts.length === 1 ? "" : "s"}
        {rec.incidents.length ? ` · ${rec.incidents.length} incident${rec.incidents.length === 1 ? "" : "s"}` : ""}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {rec.incidents.map((i) => (
          <p key={i.id}>
            <Badge variant={i.resolved_at ? "secondary" : "destructive"}>{i.resolved_at ? "Resolved" : "Open"}</Badge>{" "}
            <span className="font-medium">{label(i.kind)}</span>: {i.title}
            {i.activity_code ? <span className="text-muted-foreground"> ({i.activity_code})</span> : null}
          </p>
        ))}
        {rec.facts.length === 0 ? (
          <p className="text-muted-foreground">No facts were saved for this note.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="pb-1 pr-3 font-medium">Field</th>
                  <th className="pb-1 pr-3 font-medium">Value</th>
                  <th className="pb-1 pr-3 font-medium">Basis</th>
                  <th className="pb-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rec.facts.map((f, i) => (
                  <tr key={i} className="border-t align-top">
                    <td className="py-1 pr-3">{label(f.field_name)}</td>
                    <td className="py-1 pr-3 break-words">{show(f.value)}</td>
                    <td className="py-1 pr-3">{f.basis}</td>
                    <td className="py-1">
                      {f.review_status}
                      {f.reviewed_by ? <span className="block text-xs text-muted-foreground">by {f.reviewed_by}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rec.answers.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Your answers to the agent</p>
            <ul className="flex flex-col gap-1">
              {rec.answers.map((a, i) => (
                <li key={i} className="whitespace-pre-line text-muted-foreground">
                  {a}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

/** Every saved note of the signed-in member: playback, transcript, and what the agent extracted from it. */
export function RecordingsList({ projectId }: { projectId: string }) {
  const recordings = useQuery({ queryKey: RECORDINGS_KEY(projectId), queryFn: () => listRecordings(projectId), retry: false });

  return (
    <section aria-labelledby="recordings-title" className="mt-8">
      <h2 id="recordings-title" className="mb-3 text-lg font-bold">
        Your recordings
      </h2>
      {recordings.isPending ? (
        <LoadingSkeleton rows={3} />
      ) : recordings.isError ? (
        <ErrorState error={recordings.error} onRetry={() => void recordings.refetch()} />
      ) : recordings.data.length === 0 ? (
        <EmptyState title="No saved notes yet" description="Notes you capture and save appear here with playback and analysis." />
      ) : (
        <div className="flex flex-col gap-4">
          {recordings.data.map((rec) => (
            <Card key={rec.id}>
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  {rec.has_audio ? <Mic className="size-4" aria-hidden /> : <Keyboard className="size-4" aria-hidden />}
                  {when(rec.recorded_at)}
                </CardTitle>
                <span className="text-xs text-muted-foreground">
                  {rec.id}
                  {rec.author ? ` · ${rec.author}` : " · before authorship was recorded"}
                </span>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {rec.has_audio ? (
                  <RecordingAudio src={recordingAudioUrl(projectId, rec.id)} className="w-full" />
                ) : (
                  <p className="text-xs text-muted-foreground">No audio available for this note.</p>
                )}
                {rec.transcript && <p className="text-sm">{rec.transcript}</p>}
                <Analysis rec={rec} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
