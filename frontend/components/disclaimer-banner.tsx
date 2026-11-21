import { Scale } from "lucide-react";

export const DISCLAIMER =
  "Draft for assistance only. Not legal advice. The site manager / company is responsible for the final content.";

export function DisclaimerBanner() {
  return (
    <div role="note" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
      <Scale className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>{DISCLAIMER}</p>
    </div>
  );
}
