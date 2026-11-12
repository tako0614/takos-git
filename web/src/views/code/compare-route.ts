/** Decode the browser route once; reposApi encodes the resulting literal refs. */
export function compareRouteSpec(route: string): string {
  return decodeURIComponent(route);
}
