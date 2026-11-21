"use client";

import {
  BadgeCheck,
  Bell,
  ClipboardPen,
  Gauge,
  CalendarRange,
  FileText,
  FilePen,
  HardHat,
  Home,
  ListChecks,
  Menu,
  Mic,
  Settings,
  Siren,
  Sparkles,
  TextSearch,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AsOfControl } from "@/components/as-of-control";
import { AskDrawer } from "@/components/ask-drawer";
import { EvidenceSheet } from "@/components/evidence-viewer";
import { useApp } from "@/components/providers/app-context";
import { AccountMenu, initials, SessionSync, useIdentity } from "@/components/account-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { USE_FIXTURES } from "@/lib/endpoints";
import { useAlerts, useProject } from "@/lib/queries";
import { ROLE_HOME } from "@/lib/session";
import type { Role } from "@/lib/types";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; Icon: LucideIcon; badge?: "alerts" };

/** The signed-in role's own screen, first in the navigation. */
const MY_WORK: Record<Role, NavItem> = {
  foreman: { href: ROLE_HOME.foreman, label: "Report a problem", Icon: ClipboardPen },
  site_manager: { href: ROLE_HOME.site_manager, label: "Shortfall & notice", Icon: Gauge },
  approver: { href: ROLE_HOME.approver, label: "Approvals", Icon: BadgeCheck },
};

const WORK: NavItem[] = [
  { href: "/today", label: "Home", Icon: Home },
  { href: "/capture", label: "Site notes", Icon: Mic },
  { href: "/alerts", label: "Alerts", Icon: TriangleAlert, badge: "alerts" },
  { href: "/drafts", label: "Notices", Icon: FilePen },
  { href: "/incidents", label: "Incidents", Icon: Siren },
];
const RECORDS: NavItem[] = [
  { href: "/schedule", label: "Programme", Icon: CalendarRange },
  { href: "/documents", label: "Documents", Icon: FileText },
  { href: "/actions", label: "Action items", Icon: ListChecks },
  { href: "/search", label: "Search", Icon: TextSearch },
];
const SETTINGS: NavItem = { href: "/settings", label: "Settings", Icon: Settings };

/** Mobile tab bar: four tabs around a raised capture button. */
const TABS_LEFT: NavItem[] = [WORK[0], WORK[2]];
const TABS_RIGHT: NavItem[] = [WORK[3]];
const MOBILE_MORE: NavItem[] = [WORK[4], ...RECORDS, SETTINGS];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function useAlertCount() {
  const alerts = useAlerts();
  return alerts.data?.length;
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/today" className="flex items-center gap-2.5 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <span className="flex size-8 items-center justify-center rounded-[10px] bg-primary text-primary-foreground">
        <HardHat className="size-[18px]" aria-hidden />
      </span>
      {!compact && <span className="text-[17px] font-bold tracking-tight">SiteMate</span>}
    </Link>
  );
}

function SideLink({ item, pathname, count }: { item: NavItem; pathname: string; count?: number }) {
  const active = isActive(pathname, item.href);
  const { Icon } = item;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      <Icon className={cn("size-[18px]", active && "text-foreground")} aria-hidden />
      <span className="flex-1">{item.label}</span>
      {!!count && (
        <span className="rounded-full bg-destructive px-1.5 text-[11px] leading-5 font-semibold text-white tabular" aria-label={`${count} open`}>
          {count}
        </span>
      )}
    </Link>
  );
}

function AlertBell() {
  const alerts = useAlerts();
  const count = alerts.data?.length;
  const label = alerts.isError ? "Alerts (count unavailable)" : count === undefined ? "Alerts (loading)" : `${count} open alerts`;
  return (
    <Button asChild variant="ghost" size="icon-touch" className="relative rounded-xl" aria-label={label}>
      <Link href="/alerts">
        <Bell className="size-5" aria-hidden />
        {!!count && (
          <span className="absolute top-1 right-1 flex min-w-4.5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-4.5 font-semibold text-white ring-2 ring-background">
            {count}
          </span>
        )}
        {alerts.isError && <span className="absolute top-1 right-1 size-2 rounded-full bg-warning" />}
      </Link>
    </Button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const project = useProject();
  const alertCount = useAlertCount();
  const { setAskOpen, role } = useApp();
  const identity = useIdentity();
  const myWork = MY_WORK[role];
  const onCapture = isActive(pathname, "/capture");

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
          <SideLink item={myWork} pathname={pathname} />
          <p className="mt-5 mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Site</p>
          {WORK.map((item) => (
            <SideLink key={item.href} item={item} pathname={pathname} count={item.badge ? alertCount : undefined} />
          ))}
          <p className="mt-5 mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Records</p>
          {RECORDS.map((item) => (
            <SideLink key={item.href} item={item} pathname={pathname} />
          ))}
          <div className="mt-auto pt-4">
            <SideLink item={SETTINGS} pathname={pathname} />
          </div>
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
          <div className="flex items-center gap-2 px-4 py-3 md:px-8">
            <div className="flex min-w-0 flex-1 items-center gap-2.5 md:hidden">
              <Logo compact />
              <p className="truncate text-sm font-semibold">{project.data?.name ?? "Riverside Office Block"}</p>
            </div>
            <div className="hidden flex-1 items-center gap-2 md:flex">
              <AsOfControl />
            </div>
            <button
              type="button"
              onClick={() => setAskOpen(true)}
              className="hidden h-10 w-72 items-center gap-2.5 rounded-xl bg-card px-3.5 text-sm text-muted-foreground shadow-[0_1px_2px_rgba(17,18,20,0.04)] transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none lg:flex"
            >
              <Sparkles className="size-4" aria-hidden />
              Ask anything about the site…
            </button>
            <Button variant="ghost" size="icon-touch" className="rounded-xl lg:hidden" onClick={() => setAskOpen(true)} aria-label="Ask SiteMate">
              <Sparkles className="size-5" aria-hidden />
            </Button>
            <div className="hidden md:block">
              <AccountMenu />
            </div>
            <ThemeToggle />
            <AlertBell />
          </div>
          <div className="flex items-center gap-2 overflow-x-auto px-4 pb-2 md:hidden">
            <AsOfControl />
            <AccountMenu />
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 pt-2 pb-32 md:px-8 md:pt-4 md:pb-12">
          {children}
        </main>
      </div>

      {/* Mobile bottom tab bar with a raised capture button */}
      <nav aria-label="Main" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 backdrop-blur-md md:hidden">
        <ul className="grid grid-cols-5 items-end">
          {TABS_LEFT.map((item) => (
            <TabLink key={item.href} item={item} pathname={pathname} count={item.badge ? alertCount : undefined} />
          ))}
          <li className="flex justify-center">
            <Link
              href="/capture"
              aria-label="Record a site note"
              aria-current={onCapture ? "page" : undefined}
              className="-mt-6 mb-1.5 flex flex-col items-center gap-1 text-[11px] font-semibold focus-visible:outline-none"
            >
              <span className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_6px_18px_rgba(255,196,0,0.35)] ring-4 ring-background">
                <Mic className="size-6" aria-hidden />
              </span>
              Record
            </Link>
          </li>
          {TABS_RIGHT.map((item) => (
            <TabLink key={item.href} item={item} pathname={pathname} />
          ))}
          <li>
            <DropdownMenu>
              <DropdownMenuTrigger className="flex min-h-15 w-full flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground focus-visible:outline-none">
                <Menu className="size-5" aria-hidden />
                More
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="w-56 rounded-2xl p-1.5">
                {[myWork, ...MOBILE_MORE].map(({ href, label, Icon }) => (
                  <DropdownMenuItem key={href} asChild className="min-h-11 rounded-xl">
                    <Link href={href}>
                      <Icon aria-hidden /> {label}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        </ul>
      </nav>

      <EvidenceSheet />
      <AskDrawer />
      <SessionSync />
    </div>
  );
}

function TabLink({ item, pathname, count }: { item: NavItem; pathname: string; count?: number }) {
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
        <Icon className={cn("size-5", active && "stroke-[2.4]")} aria-hidden />
        {item.label}
        {!!count && <span className="absolute top-2 left-1/2 ml-2 size-2 rounded-full bg-destructive" aria-hidden />}
      </Link>
    </li>
  );
}
