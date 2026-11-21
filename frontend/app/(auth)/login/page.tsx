"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { FormField, describedByFor } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AuthError, signIn } from "@/lib/auth";
import { issuesToErrors, loginSchema } from "@/lib/auth-schemas";

type Values = { email: string; password: string; remember: boolean };
type DevAccount = { label: string; email: string; password: string };

/** Development only: demo logins from SITEMATE_DEV_ACCOUNTS (.env.local); empty in production builds. */
function DevAccounts({ onUse }: { onUse: (account: DevAccount) => void }) {
  const [accounts, setAccounts] = useState<DevAccount[]>([]);
  useEffect(() => {
    fetch("/api/auth/dev-accounts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { accounts: [] }))
      .then((d) => setAccounts(Array.isArray(d.accounts) ? d.accounts : []))
      .catch(() => setAccounts([]));
  }, []);
  if (!accounts.length) return null;
  return (
    <section aria-labelledby="dev-accounts" className="mt-5 rounded-xl border border-dashed border-amber-300 bg-amber-50/60 p-3 dark:bg-amber-500/10">
      <h2 id="dev-accounts" className="mb-2 text-xs font-semibold tracking-wider text-amber-900 uppercase dark:text-amber-200">
        Demo accounts · development only
      </h2>
      <ul className="flex flex-col gap-2">
        {accounts.map((a) => (
          <li key={a.email} className="flex items-center justify-between gap-2 rounded-lg bg-background px-3 py-2 text-xs ring-1 ring-border">
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{a.label}</span>
              <span className="block truncate font-mono">{a.email}</span>
              <span className="block font-mono text-muted-foreground">{a.password}</span>
            </span>
            <Button type="button" size="sm" variant="outline" onClick={() => onUse(a)}>
              Use
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function LoginPage() {
  const [values, setValues] = useState<Values>({ email: "", password: "", remember: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = <K extends keyof Values>(key: K, value: Values[K]) => setValues((v) => ({ ...v, [key]: value }));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const parsed = loginSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(issuesToErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const session = await signIn(parsed.data);
      // A full load so the app starts fresh with this user's role and the replay clock of their screen.
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.assign(next && next.startsWith("/") && !next.startsWith("//") ? next : session.home);
    } catch (err) {
      setFormError(err instanceof AuthError ? err.message : "We could not sign you in. Check your email and password and try again.");
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Sign in to SiteMate</CardTitle>
        <CardDescription>Use the work email your project admin gave you. You open on the screen for your role.</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4" aria-describedby={formError ? "login-form-error" : undefined}>
          {formError && (
            <p id="login-form-error" role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
              {formError}
            </p>
          )}

          <FormField id="email" label="Work email" error={errors.email}>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              className="h-11 md:h-9"
              value={values.email}
              onChange={(e) => set("email", e.target.value)}
              aria-invalid={!!errors.email}
              aria-describedby={describedByFor("email", errors.email)}
            />
          </FormField>

          <FormField id="password" label="Password" error={errors.password}>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              className="h-11 md:h-9"
              value={values.password}
              onChange={(e) => set("password", e.target.value)}
              aria-invalid={!!errors.password}
              aria-describedby={describedByFor("password", errors.password)}
            />
          </FormField>

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <label className="flex min-h-11 items-center gap-2 md:min-h-0">
              <input type="checkbox" className="size-4" checked={values.remember} onChange={(e) => set("remember", e.target.checked)} />
              Keep me signed in on this device
            </label>
            <Link href="/forgot-password" className="font-medium underline underline-offset-2">
              Forgot password?
            </Link>
          </div>

          <Button type="submit" size="touch" disabled={pending} className="w-full">
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <DevAccounts
          onUse={(a) => {
            setValues((v) => ({ ...v, email: a.email, password: a.password }));
            setErrors({});
            setFormError(null);
          }}
        />
      </CardContent>
      <CardFooter className="flex-col gap-1 text-center text-sm text-muted-foreground">
        <span>Accounts are issued by your project admin.</span>
        <Link href="/signup" className="text-xs underline underline-offset-2">
          Request access
        </Link>
      </CardFooter>
    </Card>
  );
}
