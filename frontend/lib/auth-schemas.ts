import { z } from "zod";
import type { Role } from "@/lib/types";

const ROLE_VALUES = ["foreman", "site_manager", "approver"] as const satisfies readonly Role[];

export const loginSchema = z.object({
  email: z.email({ error: "Enter a valid email address" }).trim(),
  password: z.string().min(1, { error: "Enter your password" }),
  remember: z.boolean(),
});

export const signUpSchema = z
  .object({
    fullName: z.string().trim().min(2, { error: "Enter your full name" }),
    company: z.string().trim().min(2, { error: "Enter your company name" }),
    role: z.enum(ROLE_VALUES, { error: "Choose your role on site" }),
    email: z.email({ error: "Enter a valid work email address" }).trim(),
    password: z.string().min(8, { error: "Use at least 8 characters" }),
    confirmPassword: z.string(),
    terms: z.boolean().refine((v) => v, { error: "Accept the terms to create an account" }),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ["confirmPassword"],
    error: "Passwords do not match",
  });

export type LoginValues = z.infer<typeof loginSchema>;
export type SignUpValues = z.infer<typeof signUpSchema>;

/** Maps the first issue for each field to a message, so each field shows one clear line. */
export function issuesToErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}
