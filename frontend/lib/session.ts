/**
 * Sign-in session: shared by the auth route handlers, the middleware and the client.
 *
 * The bearer token from POST /auth/login lives only in the httpOnly cookie SESSION_COOKIE, so page
 * scripts can never read it. HOME_COOKIE holds just the role's start page for routing; it grants nothing.
 */
import type { Role } from "@/lib/types";

export const SESSION_COOKIE = "sm_session";
export const HOME_COOKIE = "sm_home";

/** Project roles in the database (project_members.role) */
export type MemberRole = "viewer" | "contributor" | "manager" | "approver";

export interface Membership {
  project_id: string;
  project_name: string;
  member_id: string;
  role: MemberRole;
  display_name: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface Session {
  user: SessionUser;
  memberships: Membership[];
  expires_at: string;
}

/** The screen each database role opens on. */
export const APP_ROLE: Record<MemberRole, Role> = {
  contributor: "foreman",
  viewer: "foreman",
  manager: "site_manager",
  approver: "approver",
};

export const ROLE_HOME: Record<Role, string> = {
  foreman: "/foreman",
  site_manager: "/manager",
  approver: "/approver",
};

/** Sign-in is required whenever the app talks to the live API. */
export const AUTH_REQUIRED = process.env.NEXT_PUBLIC_USE_FIXTURES === "false";

export function membershipFor(session: Session | null | undefined, projectId: string): Membership | null {
  return session?.memberships.find((m) => m.project_id === projectId) ?? session?.memberships[0] ?? null;
}
