import React, { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import type { RideRequest } from '@barc/shared';
import { Banner, Body, Card, Loading, Screen, Title } from '@/components/ui.tsx';
import { RideCard } from '@/components/RideCard.tsx';
import { useApp } from '@/lib/store.ts';

export default function Rides() {
  const api = useApp((s) => s.api);
  const eventTick = useApp((s) => s.eventTick);
  const [rides, setRides] = useState<RideRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      api
        .myRides()
        .then((r) => setRides(r.rides))
        .catch((e) => setError((e as Error).message));
    }, [api, eventTick]),
  );

  return (
    <Screen>
      <Title sub="Every trip you have taken or driven on this node. It is your record; export it from the Me tab.">Rides</Title>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {rides === null ? (
        <Loading />
      ) : rides.length === 0 ? (
        <Card>
          <Body>No rides yet.</Body>
        </Card>
      ) : (
        rides.map((r) => <RideCard key={r.id} ride={r} onPress={() => router.push(`/ride/${r.id}`)} />)
      )}
    </Screen>
  );
}
