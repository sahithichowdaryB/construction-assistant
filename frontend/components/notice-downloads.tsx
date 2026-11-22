"use client";

import { useApp } from "@/components/providers/app-context";
import { Button } from "@/components/ui/button";
import { latestApproved, type NoticeDraft } from "@/lib/workflow";

/**
 * The latest approved version only: PDF and Word for letters, plus an .eml (opens unsent in Outlook or Mail) for
 * emails. Each file is rendered once from the approved wording and stored, so every download is identical; the
 * fingerprint (SHA-256) of a stored file is shown once it exists.
 */
export function NoticeDownloads({ notice }: { notice: NoticeDraft }) {
  const { projectId } = useApp();
  const approved = latestApproved(notice);
  if (!approved) return null;
  const path = `/api/sm/projects/${encodeURIComponent(projectId)}/drafts/${notice.id}/versions/${approved.version}/export`;
  const stored = Object.fromEntries(approved.exports.map((e) => [e.format, e.sha256]));
  const newer = approved.version !== notice.latest.version;
  return (
    <div className="flex flex-col gap-2" aria-label="Download approved notice">
      {newer && (
        <p className="text-xs text-muted-foreground">
          Downloads are of the approved version {approved.version}. Version {notice.latest.version} needs its own approval.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {notice.notice_type === "email" && (
          <Button asChild>
            <a href={`${path}?format=eml`} download>Open as email (.eml)</a>
          </Button>
        )}
        <Button asChild variant="outline"><a href={`${path}?format=pdf`} download>Download PDF</a></Button>
        <Button asChild variant="outline"><a href={`${path}?format=docx`} download>Download Word</a></Button>
      </div>
      {!!Object.keys(stored).length && (
        <p className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
          {Object.entries(stored).map(([fmt, sha]) => `${fmt.toUpperCase()} ${sha.slice(0, 12)}`).join(" · ")}
        </p>
      )}
    </div>
  );
}
