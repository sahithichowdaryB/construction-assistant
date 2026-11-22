import { PageSkeleton } from "@/components/route-skeletons";

/** Shown at once when any page in the app opens, until that page's code and first render are ready. */
export default function Loading() {
  return <PageSkeleton />;
}
