/**
 * Graph pagination conventions shared by the Teams action modules.
 *
 * The actual paginator lives on `TeamsClient.paginate(path, max, query)` —
 * it follows `@odata.nextLink` until either `max` items have been collected
 * or the next link is missing. Action handlers just pick a `max_results`
 * value (capped here) and pass it through.
 */

export const MAX_RESULTS_DEFAULT = 25;
export const MAX_RESULTS_CAP = 500;

export function capMax(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return MAX_RESULTS_DEFAULT;
  return Math.min(Math.floor(requested), MAX_RESULTS_CAP);
}
