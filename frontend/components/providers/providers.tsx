"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";
import { AppContextProvider } from "@/components/providers/app-context";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            // Don't retry 4xx answers such as "not available at this time"
            retry: (count, error) =>
              !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <AppContextProvider>
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
      </AppContextProvider>
    </QueryClientProvider>
  );
}
