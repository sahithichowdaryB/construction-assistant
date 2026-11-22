/**
 * Re-mounted on every page change: a thin yellow progress bar runs across the top and the new page
 * fades and rises into place. Both are skipped for people who prefer reduced motion.
 */
export default function PageTransition({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[3px] origin-left bg-primary motion-safe:animate-[page-bar_700ms_ease-out_forwards] motion-reduce:hidden" />
      <div className="motion-safe:animate-[page-in_420ms_cubic-bezier(.2,.7,.2,1)_both]">{children}</div>
    </>
  );
}
