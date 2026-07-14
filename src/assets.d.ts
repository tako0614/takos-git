/**
 * Ambient declaration for `with { type: "text" }` asset imports. The build
 * (`Bun.build`) inlines the file contents as a string; tsc has no loader for
 * `.svg`, so this wildcard module keeps the typed import honest.
 */
declare module "*.svg" {
  const content: string;
  export default content;
}

declare module "*.sql" {
  const content: string;
  export default content;
}
