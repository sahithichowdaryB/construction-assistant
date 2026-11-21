import { HardHat } from "lucide-react";
import type { ReactNode } from "react";

/** Centred layout for sign-in and sign-up. No app shell, navigation or project header. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <div className="mb-6 flex items-center gap-2">
        <HardHat className="size-7" aria-hidden />
        <span className="text-xl font-semibold tracking-tight">SiteMate</span>
      </div>
      <div className="w-full max-w-md">{children}</div>
      <p className="mt-8 text-xs text-muted-foreground">Demo build · Riverside Office Block</p>
    </main>
  );
}
