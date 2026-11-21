"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_AS_OF, toIsoWithOffset } from "@/lib/time";
import { PROJECT_ID } from "@/lib/endpoints";
import type { EvidenceRef, Role } from "@/lib/types";

const ROLE_KEY = "sitemate.role";

function readStoredRole(): Role | null {
  try {
    const v = window.localStorage.getItem(ROLE_KEY);
    return v === "foreman" || v === "site_manager" || v === "approver" ? v : null;
  } catch {
    return null;
  }
}

interface AppContextValue {
  projectId: string;
  /** ISO instant with UTC offset; every query is scoped to it */
  asOf: string;
  setAsOf: (iso: string) => void;
  role: Role;
  setRole: (role: Role) => void;
  /** Evidence sheet opened by CitationChip */
  evidence: EvidenceRef | null;
  openEvidence: (ref: EvidenceRef) => void;
  closeEvidence: () => void;
  askOpen: boolean;
  setAskOpen: (open: boolean) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppContextProvider({ children }: { children: ReactNode }) {
  const [asOf, setAsOf] = useState(DEFAULT_AS_OF);
  const [role, setRoleState] = useState<Role>("site_manager");
  const [evidence, setEvidence] = useState<EvidenceRef | null>(null);
  const [askOpen, setAskOpen] = useState(false);

  // Read the stored role after mount so server and client render the same first frame.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("role");
    const stored = fromUrl === "foreman" || fromUrl === "site_manager" || fromUrl === "approver" ? fromUrl : readStoredRole();
    if (stored) setRoleState(stored);
    // Deep link for demos: ?as_of=2026-11-10T17:30:00+01:00 (must carry a UTC offset)
    const asOfParam = params.get("as_of");
    if (asOfParam && /[+-]\d{2}:\d{2}$|Z$/.test(asOfParam) && !Number.isNaN(Date.parse(asOfParam))) {
      setAsOf(toIsoWithOffset(new Date(asOfParam)));
    }
  }, []);

  const setRole = useCallback((r: Role) => {
    setRoleState(r);
    try {
      window.localStorage.setItem(ROLE_KEY, r);
    } catch {
      /* storage unavailable (private mode); keep in memory */
    }
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      projectId: PROJECT_ID,
      asOf,
      setAsOf,
      role,
      setRole,
      evidence,
      openEvidence: setEvidence,
      closeEvidence: () => setEvidence(null),
      askOpen,
      setAskOpen,
    }),
    [asOf, role, setRole, evidence, askOpen],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppContextProvider");
  return ctx;
}
