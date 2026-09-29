/**
 * Seed a node with demo drivers so the flow can be tried on one phone.
 *
 *   npm run seed --workspace apps/server -- --lat -33.9249 --lng 18.4241
 *
 * Creates three drivers with different rate cards, online at the given
 * point. Their tokens are printed so you can also sign in as one of them
 * from a second device by pasting the token into a request, if you want.
 */
import { Store } from './db.ts';
import { newId, newToken } from './auth.ts';
import { suggestedRatesFor } from '@barc/shared';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const lat = Number(opt('lat', '-33.9249'));
const lng = Number(opt('lng', '18.4241'));
const dbPath = process.env.BARC_DB ?? opt('db', './barc.db');
const currency = (process.env.BARC_CURRENCY ?? opt('currency', 'ZAR')).toUpperCase();

const store = new Store(dbPath);
store.setSetting('currency', currency);
if (!store.getSetting('node_name', '')) store.setSetting('node_name', 'Demo Town Rides');
const base = suggestedRatesFor(currency);

const drivers = [
  { handle: 'demo_sipho', name: 'Sipho (demo)', mult: 1.0, car: { make: 'Toyota', model: 'Corolla', colour: 'white', plate: 'CA 123-456', seats: 4 } },
  { handle: 'demo_lerato', name: 'Lerato (demo)', mult: 0.85, car: { make: 'VW', model: 'Polo', colour: 'blue', plate: 'CA 987-654', seats: 4 } },
  { handle: 'demo_ahmed', name: 'Ahmed (demo)', mult: 1.2, car: { make: 'Hyundai', model: 'H1', colour: 'silver', plate: 'CA 555-111', seats: 7 } },
];

for (const [i, d] of drivers.entries()) {
  let user = store.getUserByHandle(d.handle);
  if (!user) {
    user = store.createUser({ id: newId('usr'), handle: d.handle, displayName: d.name, role: 'driver' });
    const token = newToken();
    store.createToken(token, user.id);
    console.log(`${d.handle}: token ${token}`);
  } else {
    console.log(`${d.handle}: already exists`);
  }
  store.updateUser(user.id, {
    paymentHandle: 'Cash or bank transfer',
    rates: {
      base: Math.round(base.base * d.mult * 100) / 100,
      perKm: Math.round(base.perKm * d.mult * 100) / 100,
      perMin: Math.round(base.perMin * d.mult * 100) / 100,
      minimum: Math.round(base.minimum * d.mult * 100) / 100,
      currency,
    },
    vehicle: d.car,
  });
  // Scatter them a little around the point so ETAs differ.
  store.setPresence(user.id, true, lat + (i - 1) * 0.008, lng + (i - 1) * 0.006, null);
}
store.close();
console.log(`Seeded ${drivers.length} demo drivers online near ${lat}, ${lng} in ${dbPath}.`);
