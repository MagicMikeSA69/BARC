import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { computeFare, estimateEtaMinutes, formatMoney, type RideStatus } from '@barc/shared';
import { Banner, Body, Button, Card, Field, H2, Loading, Muted, Row, Screen, StarPicker, Stars } from '@/components/ui.tsx';
import MapCanvas, { type MapPin } from '@/components/MapCanvas';
import { OfferCard } from '@/components/OfferCard.tsx';
import { STATUS_LABEL, StatusPill } from '@/components/RideCard.tsx';
import { useApp, useUser } from '@/lib/store.ts';
import { getCurrentPosition } from '@/lib/location.ts';
import type { RideDetail } from '@/lib/api.ts';
import { colors, space } from '@/lib/theme.ts';

export default function RideScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const user = useUser();
  const api = useApp((s) => s.api);
  const eventTick = useApp((s) => s.eventTick);
  const driverLocation = useApp((s) => s.driverLocation);
  const setActiveRide = useApp((s) => s.setActiveRide);
  const [detail, setDetail] = useState<RideDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const d = await api.ride(id);
      setDetail(d);
      setError(null);
      if (user && (d.ride.riderId === user.id || d.ride.driverId === user.id)) {
        setActiveRide(['completed', 'cancelled'].includes(d.ride.status) ? null : d.ride);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, id, user, setActiveRide]);

  useEffect(() => {
    load();
  }, [load, eventTick]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pins = useMemo<MapPin[]>(() => {
    if (!detail) return [];
    const out: MapPin[] = [
      { id: 'pickup', kind: 'pickup', title: 'Pickup', ...detail.ride.pickup },
      { id: 'dropoff', kind: 'dropoff', title: 'Drop-off', ...detail.ride.dropoff },
    ];
    if (driverLocation && detail.ride.status !== 'open') out.push({ id: 'driver', kind: 'driver', title: detail.driver?.displayName ?? 'Driver', ...driverLocation });
    return out;
  }, [detail, driverLocation]);

  if (!user) return null;
  if (!detail) {
    return (
      <Screen scroll={false}>
        {error ? <Banner tone="error">{error}</Banner> : <Loading label="Loading ride" />}
      </Screen>
    );
  }

  const { ride, offers, rider, driver } = detail;
  const isRider = ride.riderId === user.id;
  const isDriverOfRide = ride.driverId === user.id;
  const done = ride.status === 'completed' || ride.status === 'cancelled';

  const setStatus = (status: RideStatus) => run(status, () => api.setStatus(ride.id, status));
  const confirmCancel = () =>
    Alert.alert('Cancel this ride?', 'The other person will be told straight away.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Cancel ride', style: 'destructive', onPress: () => setStatus('cancelled') },
    ]);

  return (
    <Screen>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <Row style={{ justifyContent: 'space-between', marginBottom: space.sm }}>
        <StatusPill status={ride.status} />
        {ride.agreedFare != null ? (
          <Text style={{ fontSize: 22, fontWeight: '800', color: colors.primaryDark }}>{formatMoney(ride.agreedFare, ride.currency)}</Text>
        ) : null}
      </Row>
      <MapCanvas centre={ride.pickup} pins={pins} line={[ride.pickup, ride.dropoff]} style={{ marginBottom: space.md }} />
      <Card>
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>{ride.pickup.label}</Text>
        <Muted>to</Muted>
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>{ride.dropoff.label}</Text>
        <Muted style={{ marginTop: space.xs }}>
          ~{ride.estimatedKm} km · ~{ride.estimatedMin} min · {ride.seats} seat{ride.seats === 1 ? '' : 's'}
          {ride.maxFare != null ? ` · rider max ${formatMoney(ride.maxFare, ride.currency)}` : ''}
        </Muted>
        {ride.note ? <Muted style={{ fontStyle: 'italic' }}>“{ride.note}”</Muted> : null}
      </Card>

      {isRider ? (
        <RiderSide
          detail={detail}
          busy={busy}
          onAccept={(offerId) => run(offerId, () => api.acceptOffer(ride.id, offerId))}
          onCancel={confirmCancel}
          onRate={(stars) => run('rate', () => api.rate(ride.id, stars))}
        />
      ) : null}

      {!isRider && ride.status === 'open' ? (
        <DriverOfferForm detail={detail} busy={busy} onOffer={(fare, etaMin, message) => run('offer', () => api.makeOffer(ride.id, { fare, etaMin, message }))} onWithdraw={(offerId) => run('withdraw', () => api.withdrawOffer(ride.id, offerId))} />
      ) : null}

      {isDriverOfRide && !done ? (
        <>
          <H2>Rider</H2>
          <PersonCard person={rider} />
          <H2>Trip</H2>
          {ride.status === 'accepted' ? <Button title="I have arrived" onPress={() => setStatus('arrived')} loading={busy === 'arrived'} /> : null}
          {ride.status === 'arrived' ? <Button title="Start trip" onPress={() => setStatus('in_progress')} loading={busy === 'in_progress'} /> : null}
          {ride.status === 'in_progress' ? <Button title="Complete trip" onPress={() => setStatus('completed')} loading={busy === 'completed'} /> : null}
          {ride.status !== 'in_progress' ? <Button title="Cancel" variant="ghost" onPress={confirmCancel} style={{ marginTop: space.sm }} /> : null}
        </>
      ) : null}

      {isDriverOfRide && ride.status === 'completed' && ride.riderRating == null ? (
        <RateBox who="rider" onRate={(stars) => run('rate', () => api.rate(ride.id, stars))} busy={busy === 'rate'} />
      ) : null}

      {done ? <Button title="Back to home" variant="secondary" onPress={() => router.replace('/(tabs)')} style={{ marginTop: space.md }} /> : null}
    </Screen>
  );
}

function PersonCard({ person }: { person: RideDetail['rider'] }) {
  if (!person) return null;
  const v = person.vehicle;
  return (
    <Card>
      <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>{person.displayName}</Text>
      <Stars value={person.ratingAvg} count={person.ratingCount} />
      <Muted>{person.ridesCompleted} trips{v ? ` · ${v.colour} ${v.make} ${v.model} · ${v.plate}` : ''}</Muted>
      {person.paymentHandle ? <Muted style={{ marginTop: space.xs, color: colors.primaryDark, fontWeight: '600' }}>Payment: {person.paymentHandle}</Muted> : null}
    </Card>
  );
}

function RiderSide({
  detail,
  busy,
  onAccept,
  onCancel,
  onRate,
}: {
  detail: RideDetail;
  busy: string | null;
  onAccept: (offerId: string) => void;
  onCancel: () => void;
  onRate: (stars: number) => void;
}) {
  const { ride, offers, driver } = detail;
  if (ride.status === 'open') {
    const pending = offers.filter((o) => o.status === 'pending');
    return (
      <>
        <H2>Offers ({pending.length})</H2>
        {pending.length === 0 ? (
          <Card>
            <Loading label="Nearby drivers have been told. Offers appear here as they come in." />
          </Card>
        ) : (
          pending.map((o) => <OfferCard key={o.id} offer={o} onAccept={() => onAccept(o.id)} busy={busy === o.id} />)
        )}
        <Button title="Cancel request" variant="ghost" onPress={onCancel} />
      </>
    );
  }
  return (
    <>
      <H2>Your driver</H2>
      <PersonCard person={driver} />
      {ride.status === 'completed' ? (
        <>
          <Card>
            <Body>
              Trip complete. Pay {driver?.displayName ?? 'your driver'} {ride.agreedFare != null ? formatMoney(ride.agreedFare, ride.currency) : ''} directly
              {driver?.paymentHandle ? ` (${driver.paymentHandle})` : ''}. All of it is theirs.
            </Body>
          </Card>
          {ride.driverRating == null ? <RateBox who="driver" onRate={onRate} busy={busy === 'rate'} /> : <Muted>You rated this driver {ride.driverRating}★.</Muted>}
        </>
      ) : null}
      {ride.status === 'accepted' || ride.status === 'arrived' ? (
        <>
          <Muted style={{ marginBottom: space.sm }}>{STATUS_LABEL[ride.status]}. You can see the driver move on the map.</Muted>
          <Button title="Cancel ride" variant="ghost" onPress={onCancel} />
        </>
      ) : null}
    </>
  );
}

function RateBox({ who, onRate, busy }: { who: 'rider' | 'driver'; onRate: (stars: number) => void; busy: boolean }) {
  const [stars, setStars] = useState(5);
  return (
    <Card>
      <H2 style={{ marginTop: 0 }}>Rate your {who}</H2>
      <StarPicker value={stars} onChange={setStars} />
      <Button title="Submit rating" onPress={() => onRate(stars)} loading={busy} style={{ marginTop: space.md }} />
    </Card>
  );
}

function DriverOfferForm({
  detail,
  busy,
  onOffer,
  onWithdraw,
}: {
  detail: RideDetail;
  busy: string | null;
  onOffer: (fare: number, etaMin: number, message: string) => void;
  onWithdraw: (offerId: string) => void;
}) {
  const user = useUser();
  const { ride, offers } = detail;
  const mine = offers.find((o) => o.driverId === user?.id && o.status === 'pending');
  const suggested = user?.rates ? computeFare(user.rates, ride.estimatedKm, ride.estimatedMin).total : null;
  const [fare, setFare] = useState(mine ? String(mine.fare) : suggested != null ? String(suggested) : '');
  const [eta, setEta] = useState(mine ? String(mine.etaMin) : '');
  const [message, setMessage] = useState(mine?.message ?? '');

  useEffect(() => {
    if (eta) return;
    getCurrentPosition().then((p) => p && setEta(String(estimateEtaMinutes(p, ride.pickup))));
  }, [eta, ride.pickup]);

  const f = Number(fare);
  const e = Number(eta);
  const valid = Number.isFinite(f) && f > 0 && Number.isInteger(e) && e >= 0;

  return (
    <>
      <H2>{mine ? 'Your offer' : 'Make an offer'}</H2>
      <Card>
        {suggested != null ? <Muted style={{ marginBottom: space.sm }}>Your rate card says {formatMoney(suggested, ride.currency)}. Quote whatever you think is fair.</Muted> : null}
        <Row style={{ gap: space.sm }}>
          <Field label={`Fare (${ride.currency})`} value={fare} onChangeText={setFare} keyboardType="decimal-pad" style={{ flex: 1 }} />
          <Field label="Minutes to pickup" value={eta} onChangeText={setEta} keyboardType="number-pad" style={{ flex: 1 }} />
        </Row>
        <Field label="Message (optional)" value={message} onChangeText={setMessage} placeholder="White Corolla, I'm 5 min away" />
        <Button title={mine ? 'Update offer' : 'Send offer'} onPress={() => onOffer(f, e, message)} disabled={!valid} loading={busy === 'offer'} />
        {mine ? <Button title="Withdraw offer" variant="ghost" onPress={() => onWithdraw(mine.id)} style={{ marginTop: space.sm }} /> : null}
      </Card>
      <View style={{ height: space.md }} />
    </>
  );
}
