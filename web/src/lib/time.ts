/**
 * Epoch-milliseconds formatting helpers. Every takos-git wire timestamp is an
 * `INTEGER` Unix epoch in MILLISECONDS (contract convention), so the SPA never
 * parses ISO strings.
 */

const DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 hours ago" / "in 2 days" for an epoch-ms instant relative to now. */
export function relativeTime(epochMs: number, now: number = Date.now()): string {
  let duration = (epochMs - now) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return "";
}

/** Absolute, locale-aware timestamp for tooltips/titles. */
export function absoluteTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Short calendar date, e.g. "Jul 14, 2026". */
export function shortDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    dateStyle: "medium",
  } as Intl.DateTimeFormatOptions);
}
