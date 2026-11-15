import { Temporal } from "@js-temporal/polyfill";

// The page's clock in one module, so the UI tests can fix it (tests/ui/harness.mjs).
/** The current instant, floored to the minute (ISO 8601, UTC). */
export const currentMinute = () =>
  Temporal.Now.instant().round({ smallestUnit: "minute", roundingMode: "floor" }).toString();
