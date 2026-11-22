"use client";

import { useState } from "react";
import { useApp } from "@/components/providers/app-context";
import { Button } from "@/components/ui/button";
import { downloadOnAndroid } from "@/lib/download";
import { Input } from "@/components/ui/input";
import { useMailStatus, useSendEmail } from "@/lib/correspondence";
import type { NoticeDraft } from "@/lib/workflow";

const splitAddresses = (value: string) => value.split(/[,;\s]+/).filter(Boolean);

/** Approved versions only: PDF and Word for letters, plus an .eml and Send by email for emails. */
export function NoticeDownloads({ notice }: { notice: NoticeDraft }) {
  const { projectId } = useApp();
  const mail = useMailStatus();
  const sendEmail = useSendEmail();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  if (notice.status !== "approved") return null;
  const path = `/api/sm/projects/${encodeURIComponent(projectId)}/drafts/${notice.id}/versions/${notice.latest.version}/export`;
  const isEmail = notice.notice_type === "email";
  const canSend = isEmail && mail.data?.configured;
  const recipients = splitAddresses(to);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" aria-label="Download approved notice">
        {canSend && !sendEmail.isSuccess && <Button onClick={() => setOpen((v) => !v)}>Send by email</Button>}
        {isEmail && (
          <Button asChild variant={canSend ? "outline" : "default"}>
            <a href={`${path}?format=eml`} download>Open as email (.eml)</a>
          </Button>
        )}
        <Button asChild variant="outline"><a href={`${path}?format=pdf`} download>Download PDF</a></Button>
        <Button asChild variant="outline"><a href={`${path}?format=docx`} download>Download Word</a></Button>
      </div>
      {canSend && open && !sendEmail.isSuccess && (
        <form
          className="space-y-2 rounded-lg border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            sendEmail.mutate({ id: notice.id, version: notice.latest.version, to: recipients, cc: splitAddresses(cc) });
          }}
        >
          <label className="block space-y-1 text-sm">
            <span>To (separate several addresses with commas)</span>
            <Input type="text" inputMode="email" autoComplete="off" placeholder="name@company.com" value={to} onChange={(e) => setTo(e.target.value)} required />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Cc (optional)</span>
            <Input type="text" inputMode="email" autoComplete="off" value={cc} onChange={(e) => setCc(e.target.value)} />
          </label>
          <p className="text-xs text-muted-foreground">Sent from {mail.data?.from}. Replies go to that mailbox.</p>
          {sendEmail.isError && <p role="alert" className="text-sm text-destructive">{sendEmail.error.message}</p>}
          <Button type="submit" disabled={!recipients.length || sendEmail.isPending}>
            {sendEmail.isPending ? "Sending..." : "Send"}
          </Button>
        </form>
      )}
      {sendEmail.isSuccess && (
        <p role="status" className="text-sm">Email sent to {[...sendEmail.data.to, ...sendEmail.data.cc].join(", ")}.</p>
      )}
    </div>
  );
}
