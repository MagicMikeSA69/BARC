import React, { useCallback, useEffect, useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { formatMoney, type LatLng } from '@barc/shared';
import { Banner, Body, Button, Card, H2, Loading, Muted, Row, Screen, Stat, Title } from '@/components/ui.tsx';
import MapCanvas from '@/components/MapCanvas';
import { RideCard } from '@/components/RideCard.tsx';
import { isDriver, useApp, useUser } from '@/lib/store.ts';
import { getCurrentPosition } from '@/lib/location.ts';
import type { OpenRide } from '@/lib/api.ts';
import { colors, space } from '@/lib/theme.ts';

export default function Home() {
  const user = useUser();
  const node = useApp((s) => s.node);
  const activeRide = useApp((s) => s.activeRide);
  const refreshActiveRide = useApp((s) => s.refreshActiveRide);
  const refreshNode = useApp((s) => s.refreshNode);
  const eventTick = useApp((s) => s.eventTick);
  const api = useApp((s) => s.api);
  const [here, setHere] = useState<LatLng | null>(null);

  useEffect(() => {
    getCurrentPosition().then((p) => setHere(p ? { lat: p.lat, lng: p.lng } : api.defaultCentre));
  }, [api]);

  useFocusEffect(
    useCallback(() => {
      refreshActiveRide().catch(() => undefined);
      refreshNode().catch(() => undefined);
    }, [refreshActiveRide, refreshNode, eventTick]),
  );

  if (!user) return null;
  const driving = isDriver(user);

  return (
    <Screen>
      <Title sub={node ? `${node.name} · ${node.members} members · ${node.driversOnline} drivers online` : 'Connecting to your node'}>
        Hi {user.displayName.split(' ')[0]}
      </Title>

      {node ? (
        <Row style={{ gap: space.sm, marginBottom: space.md }}>
          <Stat label="Network take" value={`${Math.round(node.networkTakeRate * 100)}%`} />
          <Stat label="Community fund" value={`${(node.communityContributionRate * 100).toFixed(1)}%`} />
          <Stat label="Drivers online" value={String(node.driversOnline)} />
        </Row>
      ) : null}

      {activeRide && activeRide.status !== 'completed' && activeRide.status !== 'cancelled' ? (
        <>
          <H2>Your current ride</H2>
          <RideCard ride={activeRide} onPress={() => router.push(`/ride/${activeRide.id}`)} />
        </>
      ) : null}

      {driving ? <DriverPanel here={here} /> : null}
      {user.role !== 'driver' ? <RiderPanel here={here} hasActive={!!activeRide && !['completed', 'cancelled'].includes(activeRide.status)} /> : null}
    </Screen>
  );
}

function RiderPanel({ here, hasActive }: { here: LatLng | null; hasActive: boolean }) {
  return (
    <View>
      <H2>Need a ride?</H2>
      <MapCanvas centre={here} pins={here ? [{ id: 'me', kind: 'me', ...here, title: 'You' }] : []} showsUserLocation style={{ marginBottom: space.md }} />
      <Button title={hasActive ? 'Finish your current ride first' : 'Where to?'} disabled={hasActive} onPress={() => router.push('/request')} />
      <Muted style={{ marginTop: space.sm }}>
        Your request goes to nearby drivers. They send offers. You compare and choose. Pay the driver directly.
      </Muted>
    </View>
  );
}

function DriverPanel({ here }: { here: LatLng | null }) {
  const user = useUser();
  const api = useApp((s) => s.api);
  const online = useApp((s) => s.online);
  const setOnline = useApp((s) => s.setOnline);
  const eventTick = useApp((s) => s.eventTick);
  const [rides, setRides] = useState<OpenRide[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { rides } = await api.openRides(here);
      setRides(rides);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, here]);

  useEffect(() => {
    if (online) load();
  }, [online, load, eventTick]);

  useEffect(() => {
    if (!online) return;
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [online, load]);

  const toggle = async (v: boolean) => {
    if (v && !user?.rates) {
      setError('Set your rate card in the Me tab before going online.');
      return;
    }
    setOnline(v);
    if (v) {
      const p = await getCurrentPosition();
      await api.setPresence(true, p ? { lat: p.lat, lng: p.lng } : null, p?.heading ?? null).catch(() => undefined);
    }
  };

  return (
    <View>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{online ? 'You are online' : 'You are offline'}</Text>
            <Muted>
              {user?.rates
                ? `Your card: ${formatMoney(user.rates.base, user.rates.currency)} + ${formatMoney(user.rates.perKm, user.rates.currency)}/km + ${formatMoney(user.rates.perMin, user.rates.currency)}/min`
                : 'No rate card yet'}
            </Muted>
          </View>
          <Switch value={online} onValueChange={toggle} trackColor={{ true: colors.primary }} />
        </Row>
      </Card>
      {error ? <Banner tone="warn">{error}</Banner> : null}
      {online ? (
        <>
          <H2>Requests near you</H2>
          {rides === null ? (
            <Loading label="Looking for requests" />
          ) : rides.length === 0 ? (
            <Card>
              <Body>No open requests right now. You will be told the moment one comes in.</Body>
            </Card>
          ) : (
            rides.map((r) => (
              <RideCard
                key={r.id}
                ride={r}
                onPress={() => router.push(`/ride/${r.id}`)}
                extra={
                  <Muted style={{ marginTop: space.xs, color: colors.primaryDark, fontWeight: '600' }}>
                    {r.etaMin != null ? `${r.etaMin} min to pickup · ` : ''}
                    {r.suggestedFare != null ? `your card says ${formatMoney(r.suggestedFare, r.currency)}` : ''}
                    {r.maxFare != null ? ` · rider max ${formatMoney(r.maxFare, r.currency)}` : ''}
                    {r.myOffer ? ` · you offered ${formatMoney(r.myOffer.fare, r.currency)}` : ''}
                  </Muted>
                }
              />
            ))
          )}
        </>
      ) : (
        <Muted>Go online to see requests near you and make offers. Your location is only shared while you are online.</Muted>
      )}
    </View>
  );
}
