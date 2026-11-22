"use client";

import { Box, FileText, LayoutDashboard } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/performance", label: "Dashboard", Icon: LayoutDashboard },
  { href: "/performance/baseline", label: "Plans & baseline", Icon: FileText },
  { href: "/performance/model", label: "3D structure", Icon: Box },
];

/** Switch between the performance dashboard and the plans, from either page. */
export function PerfTabs() {
  const pathname = usePathname();
  return (
    <nav className="mb-5 flex gap-1 rounded-2xl bg-muted p-1" aria-label="Performance sections">
      {TABS.map(({ href, label, Icon }) => {
        const active = pathname === href || (href !== "/performance" && pathname.startsWith(href + "/"));
        return (
          <Link key={href} href={href} aria-current={active ? "page" : undefined}
                className={cn("flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-medium sm:flex-none",
                  active ? "bg-card font-semibold shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            <Icon className="size-4" aria-hidden /> {label}
          </Link>
        );
      })}
    </nav>
  );
}
