"use client";

import { ArrowLeft, MailCheck } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { FormField, describedByFor } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AuthError, requestPasswordReset } from "@/lib/auth";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState<{ message: string; dev_reset_url?: string } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter the email address you sign in with");
      return;
    }
    setError(null);
    setPending(true);
    try {
      setSent(await requestPasswordReset(email.trim()));
    } catch (err) {
      setFormError(err instanceof AuthError ? err.message : "We could not send a reset link. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Reset your password</CardTitle>
        <CardDescription>Enter your work email. We send a link that lets you choose a new password; it works once, for 30 minutes.</CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <div className="flex flex-col gap-3" role="status">
            <p className="flex gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              <MailCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> {sent.message}
            </p>
            {sent.dev_reset_url && (
              <div className="flex flex-col gap-2 rounded-md border border-dashed p-3 text-sm">
                <p className="text-muted-foreground">
                  Development mode: no mail service is connected, so the link is shown here (and in the API log).
                </p>
                <Button asChild size="touch" className="w-full">
                  <a href={sent.dev_reset_url}>Open the reset link</a>
                </Button>
              </div>
            )}
          </div>
        ) : (
          <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
            {formError && (
              <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                {formError}
              </p>
            )}
            <FormField id="email" label="Work email" error={error ?? undefined}>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                className="h-11 md:h-9"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={describedByFor("email", error ?? undefined)}
              />
            </FormField>
            <Button type="submit" size="touch" disabled={pending} className="w-full">
              {pending ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        )}
      </CardContent>
      <CardFooter className="justify-center text-sm">
        <Link href="/login" className="inline-flex items-center gap-1 font-medium underline underline-offset-2">
          <ArrowLeft className="size-3.5" aria-hidden /> Back to sign in
        </Link>
      </CardFooter>
    </Card>
  );
}
