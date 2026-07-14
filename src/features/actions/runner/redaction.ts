/**
 * Secret redaction for runner logs.
 *
 * The executor builds a redactor from the run's decrypted secret values and runs
 * EVERY streamed + sealed log chunk through it, so a secret echoed by a step
 * (`echo $NPM_TOKEN`, an error dump, a `set -x` trace) never reaches R2 or the
 * status API. Only non-trivial values are redacted (a 1-char secret would match
 * everywhere); the mask is the GitHub-style `***`.
 */

const MASK = "***";
const MIN_REDACT_LEN = 4;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a redactor over `secretValues`. Longest values first so an overlapping
 * secret is masked at its widest match. Returns identity when nothing qualifies.
 */
export function createRedactor(secretValues: readonly string[]): (text: string) => string {
  const values = [...new Set(secretValues.filter((v) => v.length >= MIN_REDACT_LEN))].sort(
    (a, b) => b.length - a.length,
  );
  if (values.length === 0) return (text) => text;
  const pattern = new RegExp(values.map(escapeRegExp).join("|"), "g");
  return (text) => text.replace(pattern, MASK);
}
