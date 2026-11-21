import type { Role } from "@/lib/types";

export const ROLES: Role[] = ["foreman", "site_manager", "approver"];

export const ROLE_LABEL: Record<Role, string> = {
  foreman: "Foreman",
  site_manager: "Site manager",
  approver: "Approver",
};

/** Demo identities used as reviewer / author names. */
export const ROLE_PERSON: Record<Role, string> = {
  foreman: "Zone B foreman",
  site_manager: "Sam Reed",
  approver: "Authorized approver",
};

export type Action =
  | "capture"
  | "confirm_capture"
  | "upload"
  | "dismiss_alert"
  | "link_incident"
  | "ask"
  | "create_draft"
  | "edit_draft"
  | "submit_review"
  | "approve"
  | "request_changes"
  | "export"
  | "analyze_incident";

const PERMISSIONS: Record<Role, Action[]> = {
  foreman: ["capture", "confirm_capture", "upload"],
  site_manager: ["upload", "dismiss_alert", "link_incident", "ask", "create_draft", "edit_draft", "submit_review", "analyze_incident"],
  approver: ["ask", "approve", "request_changes", "export", "analyze_incident"],
};

const WHO: Record<Action, string> = {
  capture: "the foreman",
  confirm_capture: "the foreman",
  upload: "the foreman or site manager",
  dismiss_alert: "the site manager",
  link_incident: "the site manager",
  ask: "the site manager or approver",
  create_draft: "the site manager",
  edit_draft: "the site manager",
  submit_review: "the site manager",
  approve: "an approver",
  request_changes: "an approver",
  export: "an approver",
  analyze_incident: "the site manager or approver",
};

export function can(role: Role, action: Action): boolean {
  return PERMISSIONS[role].includes(action);
}

/** Explanation for a disabled control, or null when allowed. */
export function denyReason(role: Role, action: Action): string | null {
  return can(role, action) ? null : `Only ${WHO[action]} can do this. You are signed in as ${ROLE_LABEL[role]}.`;
}
