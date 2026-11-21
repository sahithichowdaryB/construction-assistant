"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { FormField, describedByFor } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { signIn } from "@/lib/auth";
import { issuesToErrors, loginSchema } from "@/lib/auth-schemas";

type Values = { email: string; password: string; remember: boolean };

export default function LoginPage() {
  const router = useRouter();
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
      await signIn(parsed.data);
      router.push("/today");
    } catch {
      setFormError("We could not sign you in. Check your email and password and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Sign in to SiteMate</CardTitle>
        <CardDescription>Use the work email you registered with.</CardDescription>
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
            {/* Password reset is not built yet. Shown as text so nobody follows a dead link. */}
            <span className="text-muted-foreground" title="Password reset is not available yet">
              Forgot password? (coming soon)
            </span>
          </div>

          <Button type="submit" size="touch" disabled={pending} className="w-full">
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="justify-center text-sm text-muted-foreground">
        New to SiteMate?&nbsp;
        <Link href="/signup" className="font-medium text-foreground underline underline-offset-2">
          Create an account
        </Link>
      </CardFooter>
    </Card>
  );
}
