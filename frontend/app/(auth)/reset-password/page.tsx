"use client";

import { CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { FormField, describedByFor } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AuthError, resetPassword } from "@/lib/auth";

function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return "Use at least 10 characters";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "Use both letters and numbers";
  return null;
}

function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  if (!token) {
    return (
      <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
        This page needs the link from your reset email. <Link href="/forgot-password" className="underline">Request a new link</Link>.
      </p>
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const next = { password: passwordProblem(password) ?? undefined, confirm: confirm !== password ? "The passwords do not match" : undefined };
    setErrors(next);
    if (next.password || next.confirm) return;
    setPending(true);
    try {
      setDone((await resetPassword(token, password)).message);
    } catch (err) {
      setFormError(err instanceof AuthError ? err.message : "We could not change your password. Try again.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-3" role="status">
        <p className="flex gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> {done} Other devices have been signed out.
        </p>
        <Button asChild size="touch" className="w-full">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      {formError && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          {formError}{" "}
          {formError.includes("expired") && (
            <Link href="/forgot-password" className="underline">
              Request a new link
            </Link>
          )}
        </p>
      )}
      <FormField id="password" label="New password" error={errors.password} hint="At least 10 characters, with letters and numbers">
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          className="h-11 md:h-9"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={!!errors.password}
          aria-describedby={describedByFor("password", errors.password, "At least 10 characters, with letters and numbers")}
        />
      </FormField>
      <FormField id="confirm" label="Repeat the new password" error={errors.confirm}>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          className="h-11 md:h-9"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={!!errors.confirm}
          aria-describedby={describedByFor("confirm", errors.confirm)}
        />
      </FormField>
      <Button type="submit" size="touch" disabled={pending} className="w-full">
        {pending ? "Saving…" : "Set new password"}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Choose a new password</CardTitle>
        <CardDescription>After this, sign in with the new password. Any open sessions are signed out.</CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense fallback={null}>
          <ResetForm />
        </Suspense>
      </CardContent>
      <CardFooter className="justify-center text-sm">
        <Link href="/login" className="font-medium underline underline-offset-2">
          Back to sign in
        </Link>
      </CardFooter>
    </Card>
  );
}
