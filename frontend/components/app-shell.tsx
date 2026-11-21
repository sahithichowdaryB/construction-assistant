"use client";

import { Bell, CalendarRange, FileText, FilePen, HardHat, Home, Menu, MessageCircleQuestion, Mic, Settings, Siren, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AsOfControl } from "@/components/as-of-control";
import { AskDrawer } from "@/components/ask-drawer";
import { EvidenceSheet } from "@/components/evidence-viewer";
import { useApp } from "@/components/providers/app-context";
import { RoleSwitcher } from "@/components/role-switcher";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { USE_FIXTURES } from "@/lib/endpoints";
import { useAlerts, useProject } from "@/lib/queries";
import { cn } from "@/lib/utils";

const PRIMARY = [
  { href: "/today", label: "Today", Icon: Home },
  { href: "/capture", label: "Capture", Icon: Mic },
  { href: "/alerts", label: "Alerts", Icon: TriangleAlert },
  { href: "/documents", label: "Documents", Icon: FileText },
  { href: "/drafts", label: "Drafts", Icon: FilePen },
];
const SECONDARY = [
  { href: "/schedule", label: "Schedule", Icon: CalendarRange },
  { href: "/incidents", label: "Incidents", Icon: Siren },
  { href: "/settings", label: "Settings", Icon: Settings },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function AlertBell() {
  const alerts = useAlerts();
  const count = alerts.data?.length;
  const label = alerts.isError ? "Alerts (count unavailable)" : count === undefined ? "Alerts (loading)" : `${count} open alerts`;
  return (
    <Button asChild variant="ghost" size="icon-touch" className="relative" aria-label={label}>
      <Link href="/alerts">
        <Bell className="size-5" aria-hidden />
        {!!count && (
          <span className="absolute -top-0.5 -right-0.5 flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[11px] font-semibold text-white">
            {count}
          </span>
        )}
        {alerts.isError && <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-amber-500" />}
      </Link>
    </Button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const project = useProject();
  const { setAskOpen } = useApp();

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-background focus:p-2">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          <HardHat className="size-6" aria-hidden />
          <span className="text-lg font-semibold">SiteMate</span>
        </div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 px-2">
          {PRIMARY.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(pathname, href) ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                isActive(pathname, href) && "bg-sidebar-accent font-medium",
              )}
            >
              <Icon className="size-4" aria-hidden /> {label}
            </Link>
          ))}
          <p className="mt-4 mb-1 px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">More</p>
          {SECONDARY.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(pathname, href) ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                isActive(pathname, href) && "bg-sidebar-accent font-medium",
              )}
            >
              <Icon className="size-4" aria-hidden /> {label}
            </Link>
          ))}
        </nav>
        <p className="px-4 py-3 text-xs text-muted-foreground">{USE_FIXTURES ? "Data: fixtures" : "Data: live API + fixtures"}</p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80">
          <div className="flex items-center gap-2 px-3 py-2 md:px-6">
            <HardHat className="size-5 md:hidden" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold md:text-base">{project.data?.name ?? "Riverside Office Block"}</p>
              <p className="hidden text-xs text-muted-foreground md:block">Project {project.data?.id ?? "RIV"} · {project.data?.timezone ?? "Europe/Vienna"}</p>
            </div>
            <div className="hidden items-center gap-2 md:flex">
              <AsOfControl />
              <RoleSwitcher />
            </div>
            <Button variant="outline" size="touch" onClick={() => setAskOpen(true)} aria-label="Ask SiteMate">
              <MessageCircleQuestion aria-hidden />
              <span className="hidden lg:inline">Ask SiteMate</span>
            </Button>
            <AlertBell />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-touch" className="md:hidden" aria-label="More pages">
                  <Menu className="size-5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {SECONDARY.map(({ href, label, Icon }) => (
                  <DropdownMenuItem key={href} asChild className="min-h-11">
                    <Link href={href}>
                      <Icon aria-hidden /> {label}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex items-center gap-2 overflow-x-auto px-3 pb-2 md:hidden">
            <AsOfControl />
            <RoleSwitcher />
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-3 pt-4 pb-28 md:px-6 md:pb-10">
          {children}
        </main>
      </div>

      {/* Mobile bottom tab bar */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
        <ul className="grid grid-cols-5">
          {PRIMARY.map(({ href, label, Icon }) => {
            const active = isActive(pathname, href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] focus-visible:bg-muted focus-visible:outline-none",
                    active ? "font-semibold text-foreground" : "text-muted-foreground",
                  )}
                >
                  <Icon className={cn("size-5", active && "stroke-[2.5]")} aria-hidden />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <EvidenceSheet />
      <AskDrawer />
    </div>
  );
}
