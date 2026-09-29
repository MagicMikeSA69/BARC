import React, { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { describeRelative, formatMoney, type LatLng, type Place } from '@barc/shared';
import { Banner, Body, Button, Card, Chip, Field, H2, Loading, Muted, Row, Screen, Stars } from '@/components/ui.tsx';
import MapCanvas, { type MapPin } from '@/components/MapCanvas';
import { useApp } from '@/lib/store.ts';
import { getCurrentPosition, labelFor, searchPlace } from '@/lib/location.ts';
import type { QuoteResponse } from '@/lib/api.ts';
import { colors, space } from '@/lib/theme.ts';

type Which = 'pickup' | 'dropoff';

export default function RequestRide() {
  const api = useApp((s) => s.api);
  const node = useApp((s) => s.node);
  const setActiveRide = useApp((s) => s.setActiveRide);
  const [here, setHere] = useState<LatLng | null>(null);
  const [pickup, setPickup] = useState<Place | null>(null);
  const [dropoff, setDropoff] = useState<Place | null>(null);
  const [which, setWhich] = useState<Which>('dropoff');
  const [search, setSearch] = useState('');
  const [seats, setSeats] = useState(1);
  const [note, setNote] = useState('');
  const [maxFare, setMaxFare] = useState('');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currency = node?.currency ?? 'USD';

  useEffect(() => {
    getCurrentPosition().then(async (p) => {
      if (!p) {
        // No position from the device: fall back to the node's centre, if it has one.
        if (api.defaultCentre) {
          setHere(api.defaultCentre);
          setPickup({ ...api.defaultCentre, label: 'Town centre' });
        }
        return;
      }
      const loc = { lat: p.lat, lng: p.lng };
      setHere(loc);
      setPickup({ ...loc, label: (await labelFor(loc)) || 'Current location' });
    });
  }, [api]);

  useEffect(() => {
    if (!pickup || !dropoff) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    api
      .quotes(pickup, dropoff)
      .then((q) => !cancelled && setQuote(q))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [api, pickup, dropoff]);

  const place = async (p: LatLng) => {
    const label = (await labelFor(p)) || (here ? describeRelative(p, here, pickup?.label === 'Town centre' ? 'town centre' : 'you') : `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`);
    if (which === 'pickup') {
      setPickup({ ...p, label });
      setWhich('dropoff');
    } else {
      setDropoff({ ...p, label });
    }
  };

  const find = async () => {
    if (!search.trim()) return;
    setError(null);
    const hit = await searchPlace(search.trim());
    if (!hit) {
      setError('Could not find that place. Try a fuller address, or tap the map.');
      return;
    }
    if (which === 'pickup') setPickup({ ...hit, label: search.trim() });
    else setDropoff({ ...hit, label: search.trim() });
    setSearch('');
  };

  const submit = async () => {
    if (!pickup || !dropoff) return;
    setBusy(true);
    setError(null);
    try {
      const max = Number(maxFare);
      const { ride } = await api.createRide({
        pickup,
        dropoff,
        seats,
        note,
        maxFare: Number.isFinite(max) && max > 0 ? max : null,
        currency,
      });
      setActiveRide(ride);
      router.replace(`/ride/${ride.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pins = useMemo<MapPin[]>(() => {
    const out: MapPin[] = [];
    if (pickup) out.push({ id: 'pickup', kind: 'pickup', title: 'Pickup', ...pickup });
    if (dropoff) out.push({ id: 'dropoff', kind: 'dropoff', title: 'Drop-off', ...dropoff });
    return out;
  }, [pickup, dropoff]);

  return (
    <Screen>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <Row style={{ marginBottom: space.sm }}>
        <Chip label={`Pickup: ${pickup?.label ?? 'tap map'}`} active={which === 'pickup'} onPress={() => setWhich('pickup')} />
        <Chip label={`Drop-off: ${dropoff?.label ?? 'tap map'}`} active={which === 'dropoff'} onPress={() => setWhich('dropoff')} />
      </Row>
      <MapCanvas
        centre={here}
        pins={pins}
        line={pickup && dropoff ? [pickup, dropoff] : undefined}
        onPress={place}
        showsUserLocation
        style={{ marginBottom: space.md }}
      />
      <Row style={{ gap: space.sm, alignItems: 'flex-end' }}>
        <Field label={`Search ${which}`} value={search} onChangeText={setSearch} placeholder="Street, place or landmark" onSubmitEditing={find} returnKeyType="search" style={{ flex: 1 }} />
        <Button title="Find" variant="secondary" onPress={find} style={{ marginBottom: space.md }} />
      </Row>

      {pickup && dropoff ? (
        <>
          <H2>What drivers nearby would charge</H2>
          {quote === null ? (
            <Loading label="Asking nearby drivers' rate cards" />
          ) : (
            <Card>
              <Muted>
                ~{quote.estimatedKm} km · ~{quote.estimatedMin} min · {quote.driversNearby} driver{quote.driversNearby === 1 ? '' : 's'} nearby
              </Muted>
              {quote.range ? (
                <Text style={{ fontSize: 24, fontWeight: '800', color: colors.primaryDark, marginVertical: space.xs }}>
                  {formatMoney(quote.range.min, currency)}
                  {quote.range.max !== quote.range.min ? ` – ${formatMoney(quote.range.max, currency)}` : ''}
                </Text>
              ) : (
                <Body>No drivers online within range yet. You can still post; drivers coming online will see it.</Body>
              )}
              {quote.quotes.slice(0, 5).map((q) => (
                <View key={q.driverId} style={{ marginTop: space.sm }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={{ color: colors.text, fontWeight: '600' }}>{q.displayName}</Text>
                    <Text style={{ color: colors.text, fontWeight: '700' }}>{formatMoney(q.fare.total, currency)}</Text>
                  </Row>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Stars value={q.ratingAvg} count={q.ratingCount} />
                    <Muted>{q.etaMin} min away</Muted>
                  </Row>
                </View>
              ))}
              <Muted style={{ marginTop: space.sm }}>Estimates from each driver's own card. The offers you get are the real price. 100% goes to the driver.</Muted>
            </Card>
          )}

          <H2>Details</H2>
          <Row style={{ flexWrap: 'wrap' }}>
            {[1, 2, 3, 4].map((n) => (
              <Chip key={n} label={`${n} seat${n === 1 ? '' : 's'}`} active={seats === n} onPress={() => setSeats(n)} />
            ))}
          </Row>
          <Field label={`Most you'll pay (${currency}, optional)`} value={maxFare} onChangeText={setMaxFare} keyboardType="decimal-pad" placeholder="Leave blank to just see offers" />
          <Field label="Note for drivers (optional)" value={note} onChangeText={setNote} placeholder="Two bags, child seat needed…" />
          <Button title="Send request to nearby drivers" onPress={submit} loading={busy} />
        </>
      ) : (
        <Muted>Tap the map or search to set your {pickup ? 'drop-off' : 'pickup'}.</Muted>
      )}
    </Screen>
  );
}
