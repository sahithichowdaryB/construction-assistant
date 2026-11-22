"use client";

import { BadgeCheck, Clapperboard, Loader2, ClipboardList, ClipboardPen, Files, Gauge, HardHat, Mic, PenLine, Siren, TrendingUp, type LucideIcon } from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AskDrawer } from "@/components/ask-drawer";
import { AsOfControl } from "@/components/as-of-control";
import { EvidenceSheet } from "@/components/evidence-viewer";
import { FetchProgress, LoadingBar } from "@/components/loading-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { useApp } from "@/components/providers/app-context";
import { Backdrop } from "@/components/backdrop";
import { AccountMenu, initials, SessionSync, useIdentity } from "@/components/account-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { USE_FIXTURES } from "@/lib/endpoints";
import { useProject } from "@/lib/queries";
import { AUTH_REQUIRED, ROLE_HOME } from "@/lib/session";
import type { Role } from "@/lib/types";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; Icon: LucideIcon };

const NAV: Record<Role, NavItem[]> = {
  foreman: [
    { href: ROLE_HOME.foreman, label: "Report a problem", Icon: ClipboardPen },
    { href: "/foreman/reports", label: "My reports", Icon: ClipboardList },
  ],
  site_manager: [
    { href: ROLE_HOME.site_manager, label: "Shortfalls & notices", Icon: Gauge },
    { href: "/recaps", label: "Daily recaps", Icon: Clapperboard },
    { href: "/manager/write", label: "Write with SiteMate", Icon: PenLine },
    { href: "/performance", label: "Performance", Icon: TrendingUp },
    { href: "/documents", label: "Documents", Icon: Files },
    { href: "/incidents", label: "Incident insights", Icon: Siren },
    { href: "/capture", label: "Record a statement", Icon: Mic },
  ],
  approver: [{ href: ROLE_HOME.approver, label: "Review queue", Icon: BadgeCheck }],
};

function matches(pathname: string, href: string) {
  return pathname === href || (href !== ROLE_HOME.foreman && pathname.startsWith(href + "/"));
}

/** Active when it is the most specific nav entry for the page (/manager/write beats /manager). */
function isActive(pathname: string, href: string) {
  if (!matches(pathname, href)) return false;
  const all = Object.values(NAV).flat().map((i) => i.href);
  return !all.some((other) => other !== href && other.startsWith(href + "/") && matches(pathname, other));
}

function Logo({ compact = false }: { compact?: boolean }) {
  const { role } = useApp();
  return (
    <Link href={ROLE_HOME[role]} className="flex items-center gap-2.5 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <span className="flex size-8 items-center justify-center rounded-[10px] bg-primary text-primary-foreground">
        <HardHat className="size-[18px]" aria-hidden />
      </span>
      {!compact && <span className="text-[17px] font-bold tracking-tight">SiteMate</span>}
    </Link>
  );
}

/** Inside a Link: a spinner (and a top bar) from the click until the next page is ready. */
function LinkPending({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <>
      <Loader2 aria-label="Opening" className={cn("size-4 animate-spin text-primary", className)} />
      <LoadingBar />
    </>
  );
}

function NavSkeleton({ mobile = false }: { mobile?: boolean }) {
  return mobile ? (
    <li className="flex min-h-15 items-center justify-center gap-6" aria-hidden>
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-14 rounded-lg" />)}
    </li>
  ) : (
    <div className="flex flex-col gap-1" role="status" aria-label="Loading menu">
      {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full rounded-xl" />)}
    </div>
  );
}

function SideLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item.href);
  const { Icon } = item;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:translate-x-0.5 hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      {/* yellow marker on the current page */}
      <span aria-hidden className={cn("absolute top-1/2 left-0 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary transition-all duration-300", active ? "opacity-100" : "h-0 opacity-0")} />
      <Icon className={cn("size-[18px] transition-transform duration-200 group-hover:scale-110 group-hover:-rotate-6", active && "text-primary")} aria-hidden />
      <span className="flex-1">{item.label}</span>
      <LinkPending />
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const project = useProject();
  const { role } = useApp();
  const identity = useIdentity();
  const items = AUTH_REQUIRED && !identity.memberRole ? [] : NAV[identity.memberRole ?? role];
  const menuLoading = AUTH_REQUIRED && !identity.memberRole;
  const showClock = pathname !== "/approver" && pathname !== "/foreman/reports";

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-background focus:p-2">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-sidebar px-3 py-5 md:flex">
        <div className="px-2 pb-6">
          <Logo />
        </div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          <p className="mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">My work</p>
          {menuLoading ? <NavSkeleton /> : items.map((item) => <SideLink key={item.href} item={item} pathname={pathname} />)}
        </nav>
        <div className="mt-3 rounded-2xl bg-sidebar-accent p-3">
          <p className="text-[11px] font-medium text-muted-foreground">Project</p>
          <p className="truncate text-sm font-semibold">{project.data?.name ?? "Riverside Office Block"}</p>
          <div className="mt-3 flex items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-background text-xs font-semibold">
              {initials(identity.name)}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{identity.name}</span>
              <span className="block text-xs text-muted-foreground">
                {identity.roleLabel} · {USE_FIXTURES ? "demo data" : "live data"}
              </span>
            </span>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur-md">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 lg:px-8">
            <div className="flex min-w-0 flex-1 items-center gap-2.5 md:hidden">
              <Logo compact />
              <p className="truncate text-sm font-semibold">{project.data?.name ?? "Riverside Office Block"}</p>
            </div>
            <div className="hidden flex-1 items-center gap-2 md:flex">
              {showClock && <AsOfControl />}
            </div>
            <div className="hidden md:block">
              <AccountMenu />
            </div>
            <ThemeToggle />
          </div>
          <div className="flex items-center gap-2 overflow-x-auto px-4 pb-2 md:hidden">
            {showClock && <AsOfControl />}
            <AccountMenu />
          </div>
        </header>

        <Backdrop />
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 pt-2 pb-32 md:px-8 md:pt-4 md:pb-12">
          {children}
        </main>
      </div>

      <nav aria-label="Main" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 md:hidden">
        <ul className="grid auto-cols-fr grid-flow-col">
          {menuLoading ? <NavSkeleton mobile /> : items.map((item) => <TabLink key={item.href} item={item} pathname={pathname} />)}
        </ul>
      </nav>

      <FetchProgress />
      <EvidenceSheet />
      <AskDrawer />
      <SessionSync />
    </div>
  );
}

function TabLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item.href);
  const { Icon } = item;
  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex min-h-15 flex-col items-center justify-center gap-0.5 text-[11px] focus-visible:bg-muted focus-visible:outline-none",
          active ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
      >
        <Icon className={cn("size-5 transition-transform", active && "stroke-[2.4] text-primary motion-safe:animate-[tab-pop_350ms_ease-out]")} aria-hidden />
        {item.label}
        <LinkPending className="absolute top-1.5 right-1/4 size-3.5" />
      </Link>
    </li>
  );
}
