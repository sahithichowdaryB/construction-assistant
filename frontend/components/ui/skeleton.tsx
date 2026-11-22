import { cn } from "@/lib/utils"

/**
 * Loading placeholder. Visible on both the page background and on white cards (a foreground tint, not the
 * near-invisible muted colour), with a light band sweeping across it. The sweep is skipped, and a gentle pulse
 * used instead, for people who prefer reduced motion.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "relative overflow-hidden rounded-md bg-foreground/[0.09] motion-reduce:animate-pulse",
        "before:absolute before:inset-0 before:-translate-x-full before:bg-gradient-to-r before:from-transparent before:via-white/60 before:to-transparent",
        "before:motion-safe:animate-[shimmer_1.4s_ease-in-out_infinite] before:motion-reduce:hidden dark:before:via-white/10",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
