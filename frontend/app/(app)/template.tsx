/**
 * Re-mounted on every page change: the new page fades and rises into place (skipped for people who prefer
 * reduced motion). Loading feedback lives in loading.tsx files and the FetchProgress bar in the app shell.
 */
export default function PageTransition({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="motion-safe:animate-[page-in_420ms_cubic-bezier(.2,.7,.2,1)_both]">{children}</div>
    </>
  );
}
