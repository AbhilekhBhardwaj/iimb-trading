/**
 * Turning a rejected order into something a human can act on.
 *
 * The server answers a rejected order with HTTP 200 and `{accepted: false}` —
 * it is a normal business outcome, not a transport failure — so nothing throws
 * and the UI has to notice the flag itself. What it used to do with that flag
 * was print the raw internal identifier: a trader whose order bounced saw the
 * word `insufficient_margin` in a toast that faded after four and a half
 * seconds, while a SUCCESSFUL fill got a modal they had to dismiss. The failure
 * was quieter than the success.
 *
 * This module owns the translation. Pure and DOM-free, so every reason the
 * backend can return is pinned by a test rather than discovered in a demo.
 */

import { inr } from './format'

/** Mirrors the server's RejectionCode. */
export type RejectionCode =
  | 'no_active_round'
  | 'unknown_instrument'
  | 'invalid_qty'
  | 'invalid_side'
  | 'invalid_leverage'
  | 'missing_limit_price'
  | 'no_reference_price'
  | 'insufficient_margin'

export interface OrderRejection {
  code: RejectionCode
  requiredInr?: number
  availableInr?: number
  ticker?: string
}

/** What the UI shows: a headline, an explanation, and what to do about it. */
export interface RejectionNotice {
  title: string
  detail: string
  /** The machine code, for analytics. `unknown` when the server sent none. */
  code: string
}

/**
 * Humanize a reason string we have no case for — a newer server, or a code
 * added without updating this map. `some_new_thing` → `Some new thing.`
 *
 * Never show the raw token: underscores and lower-case are a giveaway that
 * something leaked from the inside out.
 */
function humanize(reason: string | undefined): string {
  const text = (reason ?? '').replace(/_/g, ' ').trim()
  if (!text) return 'The order was not accepted. Nothing was placed.'
  const sentence = text.charAt(0).toUpperCase() + text.slice(1)
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

/**
 * The message for a rejected order, or `null` when the order was accepted.
 *
 * Returning null for an accepted order is what lets the caller treat this as a
 * gate: no notice, carry on to the normal flow.
 */
export function rejectionMessage(res: {
  accepted?: boolean
  reason?: string
  rejection?: OrderRejection
}): RejectionNotice | null {
  // Only an EXPLICIT false is a rejection. An absent flag means an older or
  // partial payload, and refusing to trade on it would be worse than the bug.
  if (res.accepted !== false) return null

  const r = res.rejection
  const code = r?.code

  switch (code) {
    case 'insufficient_margin': {
      // The numbers are the whole point — without them this is just a scolding.
      if (r?.requiredInr !== undefined && r?.availableInr !== undefined) {
        const short = Math.max(0, r.requiredInr - r.availableInr)
        return {
          code,
          title: 'Order rejected — insufficient margin',
          detail:
            `This order needs ${inr(r.requiredInr)} but only ${inr(r.availableInr)} is available — ` +
            `you are short ${inr(short)}. Reduce the quantity, or close a position to free margin. ` +
            `Nothing was placed.`,
        }
      }
      return {
        code,
        title: 'Order rejected — insufficient margin',
        detail: 'You do not have enough available margin for this order. Reduce the quantity, or close a position to free margin. Nothing was placed.',
      }
    }
    case 'no_active_round':
      return {
        code,
        title: 'Order rejected — no active round',
        detail: 'Trading is closed until the next round is started. Nothing was placed.',
      }
    case 'unknown_instrument':
      return {
        code,
        title: 'Order rejected — unknown instrument',
        detail: `${r?.ticker ?? 'That instrument'} is not trading in this event. Nothing was placed.`,
      }
    case 'invalid_qty':
      return {
        code,
        title: 'Order rejected — invalid quantity',
        detail: 'Quantity must be a whole number of at least 1 — fractional lots cannot be traded. Nothing was placed.',
      }
    case 'invalid_side':
      return {
        code,
        title: 'Order rejected — invalid side',
        detail: 'An order must be a buy or a sell. Nothing was placed.',
      }
    case 'invalid_leverage':
      return {
        code,
        title: 'Order rejected — invalid leverage',
        detail: 'Leverage must be at least 1x. Nothing was placed.',
      }
    case 'missing_limit_price':
      return {
        code,
        title: 'Order rejected — no limit price',
        detail: 'A limit order needs a price. Enter one, or switch to a market order. Nothing was placed.',
      }
    case 'no_reference_price':
      return {
        code,
        title: 'Order rejected — no price available',
        detail: 'This instrument has no reference price yet, so the order cannot be valued. Nothing was placed.',
      }
    default:
      // Unknown code, or a server too old to send one. Still unmistakably a
      // rejection, still never showing a raw token.
      return { code: code ?? 'unknown', title: 'Order rejected', detail: humanize(res.reason) }
  }
}
