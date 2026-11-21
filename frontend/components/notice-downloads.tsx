"use client";

import { useApp } from "@/components/providers/app-context";
import { Button } from "@/components/ui/button";
import type { NoticeDraft } from "@/lib/workflow";

export function NoticeDownloads({ notice }: { notice: NoticeDraft }) {
  const { projectId } = useApp();
  if (notice.status !== "approved") return null;
  const path = `/api/sm/projects/${encodeURIComponent(projectId)}/drafts/${notice.id}/versions/${notice.latest.version}/export`;
  return (
    <div className="flex flex-wrap gap-2" aria-label="Download approved notice">
      <Button asChild variant="outline"><a href={`${path}?format=pdf`} download>Download PDF</a></Button>
      <Button asChild variant="outline"><a href={`${path}?format=docx`} download>Download Word</a></Button>
    </div>
  );
}
