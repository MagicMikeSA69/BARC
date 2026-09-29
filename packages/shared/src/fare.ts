import type { DriverRates } from './types.ts';

export interface FareBreakdown {
  base: number;
  distance: number;
  time: number;
  /** Subtotal before minimum is applied. */
  subtotal: number;
  /** Amount added to reach the driver's minimum, if any. */
  minimumTopUp: number;
  total: number;
  currency: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Compute a fare from a driver's own rate card.
 *
 * There is deliberately no surge, no demand multiplier and no platform
 * margin in this function. Whatever a driver publishes is what the rider
 * pays, and 100% of it goes to the driver.
 */
export function computeFare(rates: DriverRates, km: number, minutes: number): FareBreakdown {
  if (!(km >= 0) || !(minutes >= 0)) {
    throw new RangeError('distance and time must be non-negative numbers');
  }
  const base = round2(rates.base);
  const distance = round2(rates.perKm * km);
  const time = round2(rates.perMin * minutes);
  const subtotal = round2(base + distance + time);
  const total = Math.max(subtotal, round2(rates.minimum));
  return {
    base,
    distance,
    time,
    subtotal,
    minimumTopUp: round2(total - subtotal),
    total,
    currency: rates.currency,
  };
}

/** The lowest and highest total across a set of rate cards, for a fare range preview. */
export function fareRange(
  cards: DriverRates[],
  km: number,
  minutes: number,
): { min: number; max: number } | null {
  if (cards.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const c of cards) {
    const t = computeFare(c, km, minutes).total;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return { min, max };
}

export function validateRates(r: unknown): r is DriverRates {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  const nums = ['base', 'perKm', 'perMin', 'minimum'] as const;
  for (const k of nums) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100000) return false;
  }
  return typeof o.currency === 'string' && /^[A-Z]{3}$/.test(o.currency);
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}
