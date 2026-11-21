"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { FormField, describedByFor } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { signUp } from "@/lib/auth";
import { issuesToErrors, signUpSchema } from "@/lib/auth-schemas";
import { ROLE_LABEL, ROLES } from "@/lib/roles";
import type { Role } from "@/lib/types";

type Values = {
  fullName: string;
  company: string;
  role: Role;
  email: string;
  password: string;
  confirmPassword: string;
  terms: boolean;
};

const EMPTY: Values = { fullName: "", company: "", role: "site_manager", email: "", password: "", confirmPassword: "", terms: false };

export default function SignUpPage() {
  const router = useRouter();
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = <K extends keyof Values>(key: K, value: Values[K]) => setValues((v) => ({ ...v, [key]: value }));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const parsed = signUpSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(issuesToErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const { confirmPassword: _confirm, terms: _terms, ...account } = parsed.data;
      void _confirm;
      void _terms;
      await signUp(account);
      router.push("/today");
    } catch {
      setFormError("We could not create your account. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Create your account</CardTitle>
        <CardDescription>Use your work email so your site records stay with your company.</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4" aria-describedby={formError ? "signup-form-error" : undefined}>
          {formError && (
            <p id="signup-form-error" role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
              {formError}
            </p>
          )}

          <FormField id="fullName" label="Full name" error={errors.fullName}>
            <Input
              id="fullName"
              autoComplete="name"
              className="h-11 md:h-9"
              value={values.fullName}
              onChange={(e) => set("fullName", e.target.value)}
              aria-invalid={!!errors.fullName}
              aria-describedby={describedByFor("fullName", errors.fullName)}
            />
          </FormField>

          <FormField id="company" label="Company" error={errors.company}>
            <Input
              id="company"
              autoComplete="organization"
              className="h-11 md:h-9"
              value={values.company}
              onChange={(e) => set("company", e.target.value)}
              aria-invalid={!!errors.company}
              aria-describedby={describedByFor("company", errors.company)}
            />
          </FormField>

          <FormField id="role" label="Your role on site" error={errors.role}>
            <Select value={values.role} onValueChange={(v) => set("role", v as Role)}>
              <SelectTrigger id="role" className="h-11 w-full md:h-9" aria-invalid={!!errors.role}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

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

          <FormField id="password" label="Password" error={errors.password} hint="At least 8 characters.">
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              className="h-11 md:h-9"
              value={values.password}
              onChange={(e) => set("password", e.target.value)}
              aria-invalid={!!errors.password}
              aria-describedby={describedByFor("password", errors.password, "At least 8 characters.")}
            />
          </FormField>

          <FormField id="confirmPassword" label="Confirm password" error={errors.confirmPassword}>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              className="h-11 md:h-9"
              value={values.confirmPassword}
              onChange={(e) => set("confirmPassword", e.target.value)}
              aria-invalid={!!errors.confirmPassword}
              aria-describedby={describedByFor("confirmPassword", errors.confirmPassword)}
            />
          </FormField>

          <div className="flex flex-col gap-1">
            <label className="flex min-h-11 items-start gap-2 text-sm md:min-h-0">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={values.terms}
                onChange={(e) => set("terms", e.target.checked)}
                aria-invalid={!!errors.terms}
                aria-describedby={errors.terms ? "terms-error" : undefined}
              />
              <span>
                I agree to the terms of use. SiteMate drafts are assistance only and must be checked before they are sent.
              </span>
            </label>
            {errors.terms && (
              <p id="terms-error" className="text-xs text-red-700">
                {errors.terms}
              </p>
            )}
          </div>

          <Button type="submit" size="touch" disabled={pending} className="w-full">
            {pending ? "Creating account…" : "Create account"}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="justify-center text-sm text-muted-foreground">
        Already have an account?&nbsp;
        <Link href="/login" className="font-medium text-foreground underline underline-offset-2">
          Sign in
        </Link>
      </CardFooter>
    </Card>
  );
}
