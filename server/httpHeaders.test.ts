// @vitest-environment node
/**
 * Every API response must be uncacheable.
 *
 * A live trading API served from a cache does not return a slow answer, it
 * returns a wrong one — a book, a portfolio or a trade history as they were.
 * The symptom was Trade History appearing only after a manual refresh, because
 * a refresh sends `Cache-Control: max-age=0` and bypasses the cache the polls
 * were being served from.
 */
import { describe, expect, it } from 'vitest'
import { JSON_HEADERS, NO_STORE } from './httpHeaders'

describe('API responses are never cacheable', () => {
  it('sets no-store', () => {
    expect(JSON_HEADERS['cache-control']).toContain('no-store')
  })

  it('also sets no-cache and must-revalidate for older intermediaries', () => {
    expect(JSON_HEADERS['cache-control']).toContain('no-cache')
    expect(JSON_HEADERS['cache-control']).toContain('must-revalidate')
  })

  it('sends the HTTP/1.0 Pragma spelling some corporate proxies still honour', () => {
    expect(JSON_HEADERS.pragma).toBe('no-cache')
  })

  it('never advertises a positive max-age', () => {
    expect(JSON_HEADERS['cache-control']).not.toMatch(/max-age=[1-9]/)
  })

  it('carries no validator that would invite a 304 instead of fresh data', () => {
    const keys = Object.keys(JSON_HEADERS).map((k) => k.toLowerCase())
    expect(keys).not.toContain('etag')
    expect(keys).not.toContain('last-modified')
    expect(keys).not.toContain('expires')
  })
})

describe('the rest of the response contract is unchanged', () => {
  it('still declares JSON', () => {
    expect(JSON_HEADERS['content-type']).toBe('application/json')
  })

  it('still carries the CORS headers the client depends on', () => {
    expect(JSON_HEADERS['access-control-allow-origin']).toBe('*')
    expect(JSON_HEADERS['access-control-allow-headers']).toBe('authorization, content-type')
    expect(JSON_HEADERS['access-control-allow-methods']).toBe('GET, POST, OPTIONS')
  })

  it('every header value is a string, as writeHead requires', () => {
    for (const v of Object.values(JSON_HEADERS)) expect(typeof v).toBe('string')
  })
})

describe('NO_STORE is reusable on its own', () => {
  it('is contained in the JSON headers', () => {
    for (const [k, v] of Object.entries(NO_STORE)) {
      expect(JSON_HEADERS[k as keyof typeof JSON_HEADERS]).toBe(v)
    }
  })
})
