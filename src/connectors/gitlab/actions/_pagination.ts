/**
 * Paginate a GitLab listing endpoint: walks page=1,2,3... until maxResults
 * is reached or a short page terminates. Throws ConnectorError on HTTP
 * errors so the factory's mapError sees the canonical code.
 *
 * GitLab uses X-Next-Page header for pagination, but for simplicity we use
 * the same short-page-detection approach as the GitHub paginator: stop when
 * the server returns fewer items than requested (last page) or when we have
 * accumulated enough results (truncate).
 */
import { throwIfHttpError, type HttpResult } from "narai-primitives/toolkit";

export const GITLAB_MAX_PER_PAGE = 100;
export const MAX_RESULTS_DEFAULT = 30;
export const MAX_RESULTS_CAP = 1000;

export async function paginateGitlab<T>(
  maxResults: number,
  fetchPage: (page: number, perPage: number) => Promise<HttpResult<T[]>>,
): Promise<{ items: T[]; truncated: boolean }> {
  const perPage = Math.min(GITLAB_MAX_PER_PAGE, Math.max(1, maxResults));
  const acc: T[] = [];
  let truncated = false;
  for (let page = 1; ; page++) {
    const result = await fetchPage(page, perPage);
    throwIfHttpError(result);
    const chunk = Array.isArray(result.data) ? result.data : [];
    acc.push(...chunk);
    if (chunk.length < perPage) break;
    if (acc.length >= maxResults) {
      truncated = true;
      break;
    }
  }
  return { items: acc.slice(0, maxResults), truncated };
}
