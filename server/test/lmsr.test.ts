import { describe, expect, it } from 'vitest';
import {
  LmsrError,
  PRICE_CAP,
  maxBuyShares,
  maxSellShares,
  type Outcome,
  type PoolState,
  SCALE,
  cost,
  priceYes,
  quoteBuyAmount,
  quoteBuyShares,
  quoteSellShares,
  requiredSubsidy,
} from '../src/market/lmsr.js';

const B = 100 * SCALE; // b = 100 points
const fresh = (): PoolState => ({ b: B, qYes: 0, qNo: 0 });

/** Deterministic PRNG so fuzz tests are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('prices', () => {
  it('starts at 50%', () => {
    expect(priceYes(fresh())).toBeCloseTo(0.5, 12);
  });

  it('buying YES raises the YES price, buying NO lowers it', () => {
    const s = fresh();
    expect(quoteBuyShares(s, 'YES', 10 * SCALE).priceYesAfter).toBeGreaterThan(0.5);
    expect(quoteBuyShares(s, 'NO', 10 * SCALE).priceYesAfter).toBeLessThan(0.5);
  });

  it('stays strictly inside (0, 1) and finite after a huge trade', () => {
    const q = quoteBuyAmount(fresh(), 'YES', 1_000_000 * SCALE);
    expect(Number.isFinite(q.priceYesAfter)).toBe(true);
    expect(q.priceYesAfter).toBeLessThanOrEqual(1);
    expect(q.priceYesAfter).toBeGreaterThan(0.99);
    expect(Number.isFinite(cost(q.next))).toBe(true);
  });
});

describe('quoteBuyShares', () => {
  it('cost lies between shares*priceBefore and shares*priceAfter', () => {
    const shares = 50 * SCALE;
    const q = quoteBuyShares(fresh(), 'YES', shares);
    expect(q.amount).toBeGreaterThanOrEqual(Math.floor(shares * q.priceYesBefore));
    expect(q.amount).toBeLessThanOrEqual(Math.ceil(shares * q.priceYesAfter));
  });

  it('rejects non-positive or fractional shares', () => {
    expect(() => quoteBuyShares(fresh(), 'YES', 0)).toThrow(LmsrError);
    expect(() => quoteBuyShares(fresh(), 'YES', 1.5)).toThrow(LmsrError);
  });
});

describe('quoteBuyAmount', () => {
  it('never exceeds the budget and is (near) maximal', () => {
    const rnd = mulberry32(1);
    for (let i = 0; i < 500; i++) {
      const s: PoolState = {
        b: B,
        qYes: Math.floor(rnd() * 500 * SCALE),
        qNo: Math.floor(rnd() * 500 * SCALE),
      };
      const outcome: Outcome = rnd() < 0.5 ? 'YES' : 'NO';
      const amount = 1 + Math.floor(rnd() * 200 * SCALE);
      let q;
      try {
        q = quoteBuyAmount(s, outcome, amount);
      } catch (e) {
        expect(e).toBeInstanceOf(LmsrError);
        continue;
      }
      expect(q.amount).toBeLessThanOrEqual(amount);
      // One more unit of shares must not fit (allow 1 unit slack for float noise).
      const more = quoteBuyShares(s, outcome, q.shares + 2);
      expect(more.amount).toBeGreaterThan(amount);
    }
  });

  it('100 points at 50% buys roughly 100/0.5 shares minus slippage', () => {
    const q = quoteBuyAmount(fresh(), 'YES', 100 * SCALE);
    expect(q.shares).toBeGreaterThan(100 * SCALE);
    expect(q.shares).toBeLessThan(200 * SCALE);
  });

  it('throws when the amount is too small to buy anything', () => {
    expect(() => quoteBuyAmount(fresh(), 'YES', 0)).toThrow(LmsrError);
  });
});

describe('quoteSellShares', () => {
  it('cannot sell more than outstanding', () => {
    expect(() => quoteSellShares(fresh(), 'YES', 1)).toThrow(LmsrError);
  });

  it('buy then sell round trip never makes money', () => {
    const rnd = mulberry32(2);
    for (let i = 0; i < 1000; i++) {
      const s: PoolState = {
        b: B,
        qYes: Math.floor(rnd() * 300 * SCALE),
        qNo: Math.floor(rnd() * 300 * SCALE),
      };
      const outcome: Outcome = rnd() < 0.5 ? 'YES' : 'NO';
      const shares = 1 + Math.floor(rnd() * 100 * SCALE);
      const buy = quoteBuyShares(s, outcome, shares);
      const sell = quoteSellShares(buy.next, outcome, shares);
      expect(sell.amount).toBeLessThanOrEqual(buy.amount);
      expect(sell.next).toEqual(s);
    }
  });
});

describe('path independence', () => {
  it('splitting a buy costs at least as much as one buy, within rounding', () => {
    const s = fresh();
    const whole = quoteBuyShares(s, 'YES', 80 * SCALE);
    const a = quoteBuyShares(s, 'YES', 30 * SCALE);
    const b = quoteBuyShares(a.next, 'YES', 50 * SCALE);
    expect(a.amount + b.amount).toBeGreaterThanOrEqual(whole.amount);
    expect(a.amount + b.amount - whole.amount).toBeLessThanOrEqual(1);
  });
});

describe('market maker loss bound', () => {
  it('pool loss never exceeds requiredSubsidy(b) under random trading', () => {
    const subsidy = requiredSubsidy(B);
    expect(subsidy).toBe(Math.ceil(B * Math.LN2));

    for (let seed = 0; seed < 50; seed++) {
      const rnd = mulberry32(100 + seed);
      let s = fresh();
      let netIn = 0; // points collected by the pool minus points paid out
      const holdings = { YES: 0, NO: 0 };

      for (let step = 0; step < 300; step++) {
        const outcome: Outcome = rnd() < 0.5 ? 'YES' : 'NO';
        const sell = holdings[outcome] > 0 && rnd() < 0.3;
        if (sell) {
          const n = 1 + Math.floor(rnd() * holdings[outcome]);
          const q = quoteSellShares(s, outcome, n);
          s = q.next;
          netIn -= q.amount;
          holdings[outcome] -= n;
        } else {
          const amount = 1 + Math.floor(rnd() * 50 * SCALE);
          try {
            const q = quoteBuyAmount(s, outcome, amount);
            s = q.next;
            netIn += q.amount;
            holdings[outcome] += q.shares;
          } catch {
            /* amount too small, skip */
          }
        }
        expect(s.qYes).toBe(holdings.YES);
        expect(s.qNo).toBe(holdings.NO);
      }

      // At resolution each winning share pays SCALE units (1 point).
      for (const winner of ['YES', 'NO'] as const) {
        const payout = winner === 'YES' ? s.qYes : s.qNo;
        const loss = payout - netIn;
        expect(loss).toBeLessThanOrEqual(subsidy);
      }
    }
  });
});

describe('price cap helpers', () => {
  it('maxBuyShares lands exactly at the cap', () => {
    const s = fresh();
    const n = maxBuyShares(s, 'YES');
    expect(n).toBe(Math.floor(B * Math.log(PRICE_CAP / (1 - PRICE_CAP))));
    expect(quoteBuyShares(s, 'YES', n).priceYesAfter).toBeLessThanOrEqual(PRICE_CAP);
    expect(quoteBuyShares(s, 'YES', n + 2).priceYesAfter).toBeGreaterThan(PRICE_CAP);
  });

  it('maxBuyShares is <= 0 once the price is at or past the cap', () => {
    const s: PoolState = { b: B, qYes: maxBuyShares(fresh(), 'YES') + 10, qNo: 0 };
    expect(maxBuyShares(s, 'YES')).toBeLessThanOrEqual(0);
    expect(maxBuyShares(s, 'NO')).toBeGreaterThan(0);
  });

  it('maxSellShares keeps the opposite price under the cap and never exceeds holdings', () => {
    const s: PoolState = { b: B, qYes: 1500 * SCALE, qNo: 1000 * SCALE };
    const n = maxSellShares(s, 'YES');
    expect(n).toBeLessThan(s.qYes);
    const q = quoteSellShares(s, 'YES', n);
    expect(1 - q.priceYesAfter).toBeLessThanOrEqual(PRICE_CAP + 1e-12);

    const small: PoolState = { b: B, qYes: 10 * SCALE, qNo: 0 };
    expect(maxSellShares(small, 'YES')).toBe(small.qYes);
  });
});
