import type { Polled } from "@ehf/ui-client/react";
import { Button, FreshnessIndicator, Skeleton, StaleDataBanner } from "@ehf/ui-kit";
import type { ReactNode } from "react";
import { reasonCopy, ApiErrorView } from "./errors";

/**
 * Standard rendering of a polled region (§9.1): skeleton first, error with retry when there
 * is nothing to show, and a stale banner above the last good data when a refresh fails.
 */
export function Region<T>({ polled, label, skeletonHeight = 240, children }: { polled: Polled<T>; label: string; skeletonHeight?: number; children: (data: T) => ReactNode }) {
  if (polled.data === undefined) {
    if (polled.error) return <ApiErrorView error={polled.error} action={<Button onClick={polled.refresh}>Retry</Button>} />;
    return <Skeleton height={skeletonHeight} label={`Loading ${label}`} />;
  }
  return (
    <>
      {polled.state === "stale" ? (
        <StaleDataBanner
          lastValidAt={polled.updatedAt ? new Date(polled.updatedAt).toISOString() : null}
          {...(polled.error ? { reason: `${reasonCopy(polled.error)} (${polled.error.reason})` } : {})}
          onRetry={polled.refresh}
        />
      ) : null}
      {children(polled.data)}
    </>
  );
}

/** Freshness chip + refresh for a page's main polled resource. */
export function Freshness<T>({ polled }: { polled: Polled<T> }) {
  return (
    <FreshnessIndicator
      updatedAt={polled.updatedAt ? new Date(polled.updatedAt).toISOString() : null}
      {...(polled.intervalMs ? { intervalSec: Math.round(polled.intervalMs / 1000) } : {})}
      refreshing={polled.isRefreshing}
      stale={polled.state === "stale"}
      onRefresh={polled.refresh}
    />
  );
}
