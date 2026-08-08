/**
 * Response headers shared by every API reply.
 *
 * Lives in its own module (rather than inline in api.ts) so it can be asserted
 * by a test without importing the server entrypoint, which starts listening on
 * import.
 *
 * `no-store` is the load-bearing part. A live trading API must never be served
 * from a cache: portfolio, depth and snapshot responses describe a book that
 * changes by the second, and a stale body is not a slow answer but a WRONG one.
 * With no Cache-Control, no ETag and no Last-Modified, a response is eligible
 * for heuristic caching by the browser or any intermediary — which showed up as
 * Trade History appearing only after a manual refresh, since a refresh sends
 * `Cache-Control: max-age=0` and bypasses exactly that.
 *
 * `Pragma` is the HTTP/1.0 spelling, still honoured by some corporate proxies.
 */
export const NO_STORE = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  pragma: 'no-cache',
} as const

export const JSON_HEADERS = {
  'content-type': 'application/json',
  ...NO_STORE,
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
} as const
