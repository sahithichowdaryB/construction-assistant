import {
  Building2,
  CalendarRange,
  ClipboardList,
  FileText,
  Image as ImageIcon,
  Mail,
  Mic,
  NotebookPen,
  PencilRuler,
  StickyNote,
  Table2,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { SourceType } from "@/lib/types";
import { cn } from "@/lib/utils";

const ICONS: Record<SourceType, LucideIcon> = {
  daily_report: ClipboardList,
  diary: NotebookPen,
  minutes: Users,
  email: Mail,
  voice: Mic,
  photo: ImageIcon,
  register: Table2,
  schedule: CalendarRange,
  project: Building2,
  text: StickyNote,
  plan: PencilRuler,
};

const TONES: Record<SourceType, string> = {
  daily_report: "bg-sky-50 text-sky-800 ring-sky-200",
  diary: "bg-amber-50 text-amber-800 ring-amber-200",
  minutes: "bg-violet-50 text-violet-800 ring-violet-200",
  email: "bg-rose-50 text-rose-800 ring-rose-200",
  voice: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  photo: "bg-teal-50 text-teal-800 ring-teal-200",
  register: "bg-slate-100 text-slate-700 ring-slate-200",
  schedule: "bg-indigo-50 text-indigo-800 ring-indigo-200",
  project: "bg-stone-100 text-stone-700 ring-stone-200",
  text: "bg-stone-100 text-stone-700 ring-stone-200",
  plan: "bg-red-50 text-red-800 ring-red-200",
};

/** Square tile with an icon for the document type, used in lists and headers. */
export function SourceIcon({ type, size = "md", className }: { type: SourceType; size?: "sm" | "md" | "lg"; className?: string }) {
  const Icon = ICONS[type] ?? FileText;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg ring-1 ring-inset",
        TONES[type] ?? "bg-muted text-muted-foreground ring-border",
        size === "sm" && "size-7 [&_svg]:size-3.5",
        size === "md" && "size-9 [&_svg]:size-4",
        size === "lg" && "size-11 [&_svg]:size-5",
        className,
      )}
    >
      <Icon />
    </span>
  );
}
