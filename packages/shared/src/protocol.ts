/**
 * The BARC protocol: rules every node and client agrees to. These are not
 * configuration knobs; they are the constitution of the network.
 */
export const PROTOCOL_VERSION = '0.1.0';

/**
 * Fraction of every fare kept by the network operator. Fixed at zero.
 * A node that charges a take is not a BARC node.
 */
export const NETWORK_TAKE_RATE = 0 as const;

/** Upper bound on any member-voted contribution, so a node can never quietly become a platform. */
export const MAX_COMMUNITY_CONTRIBUTION_RATE = 0.05;

/** How far around a pickup a node looks for online drivers, in km. */
export const DEFAULT_MATCH_RADIUS_KM = 12;

/** Open requests expire if nobody accepts an offer within this window. */
export const REQUEST_TTL_MINUTES = 30;

export const PRINCIPLES: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Drivers set the price',
    body: 'Every driver publishes their own rate card. No algorithm, no surge, no hidden margin. What you see is what the driver earns.',
  },
  {
    title: 'Riders choose the driver',
    body: 'A request goes out to nearby drivers. They make offers. You compare price, time, rating and car and pick one yourself.',
  },
  {
    title: 'Zero platform take',
    body: 'BARC keeps 0% of every fare, by protocol. Members may vote a small contribution to fund hosting, capped at 5%, and can vote it back down.',
  },
  {
    title: 'Pay each other directly',
    body: 'Money moves from rider to driver: cash, bank, mobile money, whatever both agree on. No corporate wallet sits in between.',
  },
  {
    title: 'One member, one vote',
    body: 'Rules, fees and features are decided by proposals that any member can raise and everyone can vote on.',
  },
  {
    title: 'Your reputation is yours',
    body: 'Ratings and ride history belong to you. Export them at any time and take them to another node.',
  },
  {
    title: 'Anyone can run a node',
    body: 'The coordination server is small and open source. A town, a taxi association or a group of friends can host their own.',
  },
];

/**
 * A starter rate card for a new driver, in the node's currency. Shown as a
 * suggestion only; drivers change it freely.
 */
export const SUGGESTED_RATES = {
  ZAR: { base: 15, perKm: 9, perMin: 1.2, minimum: 35, currency: 'ZAR' },
  USD: { base: 1.5, perKm: 0.9, perMin: 0.2, minimum: 5, currency: 'USD' },
  EUR: { base: 1.5, perKm: 0.9, perMin: 0.2, minimum: 5, currency: 'EUR' },
  GBP: { base: 1.5, perKm: 0.9, perMin: 0.2, minimum: 5, currency: 'GBP' },
} as const;

export function suggestedRatesFor(currency: string) {
  return (
    SUGGESTED_RATES[currency as keyof typeof SUGGESTED_RATES] ?? {
      ...SUGGESTED_RATES.USD,
      currency,
    }
  );
}
