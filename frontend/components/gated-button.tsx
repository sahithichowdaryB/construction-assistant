"use client";

import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** A button that stays visible when disabled and explains why in a tooltip (and to screen readers). */
export function GatedButton({ reason, children, ...props }: ComponentProps<typeof Button> & { reason: string | null }) {
  if (!reason) return <Button {...props}>{children}</Button>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label={`${typeof children === "string" ? children : ""} unavailable: ${reason}`}>
          <Button {...props} disabled aria-disabled className={`pointer-events-none ${props.className ?? ""}`}>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{reason}</TooltipContent>
    </Tooltip>
  );
}
