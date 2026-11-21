"use client";

import { UserRound } from "lucide-react";
import { useApp } from "@/components/providers/app-context";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ROLE_LABEL, ROLES } from "@/lib/roles";
import type { Role } from "@/lib/types";

/** Demo-only role switch. The real API will take the role from the signed-in member. */
export function RoleSwitcher() {
  const { role, setRole } = useApp();
  return (
    <Select value={role} onValueChange={(v) => setRole(v as Role)}>
      <SelectTrigger className="h-11 min-w-fit rounded-xl md:h-9" aria-label="Demo role">
        <UserRound className="size-4" aria-hidden />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((r) => (
          <SelectItem key={r} value={r} className="min-h-11 md:min-h-8">
            {ROLE_LABEL[r]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
