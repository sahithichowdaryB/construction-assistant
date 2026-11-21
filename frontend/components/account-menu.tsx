"use client";

import { ChevronDown, LogOut } from "lucide-react";
import { useEffect } from "react";
import { useApp } from "@/components/providers/app-context";
import { RoleSwitcher } from "@/components/role-switcher";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { roleOf, useSession, useSignOut } from "@/lib/auth";
import { ROLE_LABEL, ROLE_PERSON } from "@/lib/roles";
import { AUTH_REQUIRED, membershipFor } from "@/lib/session";

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase())
    .slice(0, 2)
    .join("");
}

/** Who is signed in: the session user in live mode, the demo persona in fixture mode. */
export function useIdentity() {
  const { role, projectId } = useApp();
  const session = useSession();
  const membership = membershipFor(session.data, projectId);
  return {
    name: membership?.display_name ?? session.data?.user.name ?? ROLE_PERSON[role],
    email: session.data?.user.email ?? null,
    roleLabel: ROLE_LABEL[role],
    signedIn: !!session.data,
  };
}

/** Keeps the app's role in step with the signed-in member, and sends a lapsed session to sign-in. */
export function SessionSync() {
  const { projectId, setRole } = useApp();
  const session = useSession();
  const role = roleOf(membershipFor(session.data, projectId));
  useEffect(() => {
    if (!AUTH_REQUIRED) return;
    if (session.data === null) window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    else if (role) setRole(role);
  }, [session.data, role, setRole]);
  return null;
}

/** Header control: the account menu with Sign out, or the demo role switch in fixture mode. */
export function AccountMenu() {
  const identity = useIdentity();
  const signOut = useSignOut();
  if (!AUTH_REQUIRED) return <RoleSwitcher />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-11 gap-2 rounded-xl pr-2 pl-1.5 md:h-9" aria-label={`Account: ${identity.name}`}>
          <span className="flex size-7 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground md:size-6">
            {initials(identity.name)}
          </span>
          <span className="hidden flex-col items-start leading-tight sm:flex">
            <span className="text-xs font-semibold">{identity.name}</span>
            <span className="text-[10px] text-muted-foreground">{identity.roleLabel}</span>
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 rounded-2xl p-1.5">
        <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
          <span className="text-sm font-semibold">{identity.name}</span>
          {identity.email && <span className="truncate text-xs text-muted-foreground">{identity.email}</span>}
          <span className="mt-1 w-fit rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">{identity.roleLabel}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()} className="min-h-11 rounded-xl md:min-h-9">
          <LogOut aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
