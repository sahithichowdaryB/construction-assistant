"use client";

import { useApp } from "@/components/providers/app-context";
import { Button } from "@/components/ui/button";
import { downloadOnAndroid } from "@/lib/download";
import type { NoticeDraft } from "@/lib/workflow";

/** Approved versions only: PDF and Word for letters, plus an .eml (opens unsent in Outlook or Mail) for emails. */
export function NoticeDownloads({ notice }: { notice: NoticeDraft }) {
  const { projectId } = useApp();
  if (notice.status !== "approved") return null;
  const path = `/api/sm/projects/${encodeURIComponent(projectId)}/drafts/${notice.id}/versions/${notice.latest.version}/export`;
  return (
    <div className="flex flex-wrap gap-2" aria-label="Download approved notice">
      {notice.notice_type === "email" && (
        <Button asChild>
          <a href={`${path}?format=eml`} download={`email-${notice.id}-v${notice.latest.version}.eml`} onClick={downloadOnAndroid}>Open as email (.eml)</a>
        </Button>
      )}
      <Button asChild variant="outline"><a href={`${path}?format=pdf`} download={`notice-${notice.id}-v${notice.latest.version}.pdf`} onClick={downloadOnAndroid}>Download PDF</a></Button>
      <Button asChild variant="outline"><a href={`${path}?format=docx`} download={`notice-${notice.id}-v${notice.latest.version}.docx`} onClick={downloadOnAndroid}>Download Word</a></Button>
    </div>
  );
}
