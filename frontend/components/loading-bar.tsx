"use client";

import { useIsFetching } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/** Thin yellow bar across the top of the screen. Static (but visible) for people who prefer reduced motion. */
export function LoadingBar() {
  return (
    <div role="progressbar" aria-label="Loading" className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[3px] overflow-hidden bg-primary/15">
      <span className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary motion-safe:animate-[bar-slide_1.1s_ease-in-out_infinite] motion-reduce:w-full motion-reduce:animate-pulse" />
    </div>
  );
}

/**
 * Shows the bar while any query is loading data it has never had (first load of a page, or a new day/clock).
 * Background refreshes and polling are ignored, so the bar does not flicker. It appears after 150 ms so quick
 * loads do not flash, and stays at least 400 ms once shown.
 */
export function FetchProgress() {
  const loading = useIsFetching({ predicate: (q) => q.state.data === undefined }) > 0;
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (loading) {
      const t = window.setTimeout(() => setShow(true), 150);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setShow(false), 400);
    return () => window.clearTimeout(t);
  }, [loading]);
  return show ? <LoadingBar /> : null;
}
