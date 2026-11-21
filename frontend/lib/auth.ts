/**
 * Authentication for the sign-in page and the app shell.
 *
 * Accounts are Supabase Auth users linked to project members (sitemate.project_members.auth_user_id).
 * The browser only talks to /api/auth/*; the session token stays in an httpOnly cookie set there.
 */
"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { APP_ROLE, AUTH_REQUIRED, ROLE_HOME, type Membership, type Session } from "@/lib/session";
import type { Role } from "@/lib/types";

export interface SignInInput {
  email: string;
  password: string;
  remember: boolean;
}

export interface SignUpInput {
  fullName: string;
  company: string;
  role: Role;
  email: string;
  password: string;
}

export class AuthError extends Error {}

export interface SignInResult extends Session {
  /** Start page for the member's role, with the replay clock set for the demo story */
  home: string;
}

export async function signIn(input: SignInInput): Promise<SignInResult> {
  let res: Response;
  try {
    res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    throw new AuthError("Network error. Check your connection and try again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new AuthError(typeof data?.detail === "string" ? data.detail : "Sign-in failed");
  const role = roleOf(data.memberships?.[0]);
  return { ...data, home: role ? ROLE_HOME[role] : "/today" };
}

async function postJson(path: string, body: unknown) {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new AuthError("Network error. Check your connection and try again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.detail;
    throw new AuthError(typeof detail === "string" ? detail : Array.isArray(detail) ? "Check the form and try again." : "Request failed");
  }
  return data;
}

/** Sends a single-use reset link. dev_reset_url is only returned when the API runs with AUTH_DEV_RESET_LINKS=true. */
export async function requestPasswordReset(email: string): Promise<{ message: string; dev_reset_url?: string }> {
  return postJson("/api/auth/password/forgot", { email });
}

export async function resetPassword(token: string, password: string): Promise<{ message: string }> {
  return postJson("/api/auth/password/reset", { token, password });
}

export async function signOut(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
}

// Accounts are issued by the project admin (backend/seed_demo_users.py); there is no self sign-up.
export async function signUp(input: SignUpInput): Promise<void> {
  void input;
  throw new AuthError("Self sign-up is not available. Ask your project admin for an account.");
}

export function roleOf(membership: Membership | null | undefined): Role | null {
  return membership ? APP_ROLE[membership.role] : null;
}

/** The signed-in user (live mode). null when signed out; disabled in fixture mode. */
export function useSession() {
  return useQuery({
    queryKey: ["auth", "me"],
    enabled: AUTH_REQUIRED,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<Session | null> => {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      if (res.status === 401) return null;
      if (!res.ok) throw new AuthError("Could not load your account");
      return res.json();
    },
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return async () => {
    await signOut();
    qc.clear();
    window.location.assign("/login");
  };
}
