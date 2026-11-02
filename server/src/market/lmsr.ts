/**
 * Binary LMSR (Logarithmic Market Scoring Rule) automated market maker.
 *
 * All quantities are integers in "units": 1 point = 1 share = SCALE units.
 * Each winning share pays out SCALE units (1 point) at resolution.
 *
 *   C(q)   = b * ln(e^(qYes/b) + e^(qNo/b))
 *   p_yes  = e^(qYes/b) / (e^(qYes/b) + e^(qNo/b))
 *   cost of a trade = C(q_after) - C(q_before)
 *
 * The market maker's worst-case loss, starting from q = (0, 0), is b * ln 2.
 * Rounding always favours the pool: buy costs round up, sell proceeds round down.
 */

export const SCALE = 1000;

export type Outcome = 'YES' | 'NO';
export type Side = 'BUY' | 'SELL';

export interface PoolState {
  /** Liquidity parameter, in units. Larger b = prices move less per trade. */
  b: number;
  /** Outstanding YES shares, in units. */
  qYes: number;
  /** Outstanding NO shares, in units. */
  qNo: number;
}

export interface Quote {
  outcome: Outcome;
  side: Side;
  /** Shares bought or sold, in units. */
  shares: number;
  /** Points paid (BUY) or received (SELL), in units. */
  amount: number;
  /** YES probability before / after the trade, in [0, 1]. */
  priceYesBefore: number;
  priceYesAfter: number;
  /** Average price per share paid/received, in points per share. */
  avgPrice: number;
  /** Pool state after the trade. */
  next: PoolState;
}

export class LmsrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LmsrError';
  }
}

function assertPositiveInt(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v <= 0) {
    throw new LmsrError(`${name} must be a positive integer, got ${v}`);
  }
}

function assertState(s: PoolState): void {
  assertPositiveInt('b', s.b);
  if (!Number.isSafeInteger(s.qYes) || s.qYes < 0) throw new LmsrError(`invalid qYes ${s.qYes}`);
  if (!Number.isSafeInteger(s.qNo) || s.qNo < 0) throw new LmsrError(`invalid qNo ${s.qNo}`);
}

function logSumExp(a: number, b: number): number {
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

/** Cost function C(q), in units (float). */
export function cost(s: PoolState): number {
  return s.b * logSumExp(s.qYes / s.b, s.qNo / s.b);
}

/** Current YES probability in [0, 1]. */
export function priceYes(s: PoolState): number {
  return 1 / (1 + Math.exp((s.qNo - s.qYes) / s.b));
}

export function priceOf(s: PoolState, outcome: Outcome): number {
  const p = priceYes(s);
  return outcome === 'YES' ? p : 1 - p;
}

/** Subsidy the market creator must lock = worst-case pool loss, in units. */
export function requiredSubsidy(b: number): number {
  assertPositiveInt('b', b);
  return Math.ceil(b * Math.LN2);
}

function held(s: PoolState, outcome: Outcome): number {
  return outcome === 'YES' ? s.qYes : s.qNo;
}

function withDelta(s: PoolState, outcome: Outcome, delta: number): PoolState {
  return outcome === 'YES'
    ? { b: s.b, qYes: s.qYes + delta, qNo: s.qNo }
    : { b: s.b, qYes: s.qYes, qNo: s.qNo + delta };
}

function makeQuote(
  s: PoolState,
  next: PoolState,
  outcome: Outcome,
  side: Side,
  shares: number,
  amount: number,
): Quote {
  return {
    outcome,
    side,
    shares,
    amount,
    priceYesBefore: priceYes(s),
    priceYesAfter: priceYes(next),
    avgPrice: amount / shares,
    next,
  };
}

/** Exact cost (rounded up) of buying `shares` units of `outcome`. */
function buyCost(s: PoolState, outcome: Outcome, shares: number): number {
  return Math.ceil(cost(withDelta(s, outcome, shares)) - cost(s));
}

/** Buy an exact number of shares. */
export function quoteBuyShares(s: PoolState, outcome: Outcome, shares: number): Quote {
  assertState(s);
  assertPositiveInt('shares', shares);
  const next = withDelta(s, outcome, shares);
  assertState(next);
  return makeQuote(s, next, outcome, 'BUY', shares, buyCost(s, outcome, shares));
}

/**
 * Spend at most `amount` units on `outcome`; returns the largest whole number
 * of share units whose (rounded-up) cost fits in the budget.
 */
export function quoteBuyAmount(s: PoolState, outcome: Outcome, amount: number): Quote {
  assertState(s);
  assertPositiveInt('amount', amount);

  // Closed form: after spending m, C' = C + m and
  //   q_mine' = b * ln(e^(C'/b) - e^(q_other/b))
  // computed stably as  A + ln(1 - e^(B - A))  with A = C'/b, B = q_other/b.
  const mine = held(s, outcome);
  const other = outcome === 'YES' ? s.qNo : s.qYes;
  const A = (cost(s) + amount) / s.b;
  const B = other / s.b;
  const newMine = s.b * (A + Math.log1p(-Math.exp(B - A)));

  let shares = Math.floor(newMine - mine);
  // Guard against float noise pushing the rounded-up cost over budget.
  while (shares > 0 && buyCost(s, outcome, shares) > amount) shares--;
  if (shares <= 0) throw new LmsrError('amount too small to buy any shares');

  const next = withDelta(s, outcome, shares);
  assertState(next);
  return makeQuote(s, next, outcome, 'BUY', shares, buyCost(s, outcome, shares));
}

/** Sell `shares` units of `outcome` back to the pool. */
export function quoteSellShares(s: PoolState, outcome: Outcome, shares: number): Quote {
  assertState(s);
  assertPositiveInt('shares', shares);
  if (shares > held(s, outcome)) {
    throw new LmsrError('cannot sell more shares than are outstanding');
  }
  const next = withDelta(s, outcome, -shares);
  const proceeds = Math.max(0, Math.floor(cost(s) - cost(next)));
  return makeQuote(s, next, outcome, 'SELL', shares, proceeds);
}
