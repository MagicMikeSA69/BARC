import React, { useEffect, useRef } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { colors } from '@/lib/theme.ts';
import { isDriver, useApp } from '@/lib/store.ts';
import { useLivePosition } from '@/lib/location.ts';

/**
 * Keeps the realtime channel open while signed in and, for drivers who are
 * online, publishes position to the node. Nothing is shared while offline.
 */
function RealtimeBridge() {
  const session = useApp((s) => s.session);
  const api = useApp((s) => s.api);
  const online = useApp((s) => s.online);
  const activeRide = useApp((s) => s.activeRide);
  const handleEvent = useApp((s) => s.handleEvent);
  const channel = useRef<ReturnType<typeof api.connect> | null>(null);

  useEffect(() => {
    if (!session) return;
    channel.current = api.connect(handleEvent);
    return () => {
      channel.current?.close();
      channel.current = null;
    };
  }, [session?.token, session?.nodeUrl, api, handleEvent]);

  const driving = !!session && isDriver(session.user);
  const onTrip = driving && !!activeRide && activeRide.driverId === session?.user.id && activeRide.status !== 'open';

  useLivePosition(driving && (online || onTrip), (p) => {
    channel.current?.send({ type: 'presence', online: online || onTrip, location: { lat: p.lat, lng: p.lng }, heading: p.heading });
    if (onTrip && activeRide) api.shareLocation(activeRide.id, { lat: p.lat, lng: p.lng }, p.heading).catch(() => undefined);
  });

  // Tell the node when a driver toggles offline so riders stop seeing them.
  useEffect(() => {
    if (!driving || online || onTrip) return;
    channel.current?.send({ type: 'presence', online: false, location: null, heading: null });
    api.setPresence(false, null).catch(() => undefined);
  }, [driving, online, onTrip, api]);

  return null;
}

export default function RootLayout() {
  const boot = useApp((s) => s.boot);
  useEffect(() => {
    boot();
  }, [boot]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="dark" />
      <RealtimeBridge />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="request" options={{ title: 'Request a ride', presentation: 'modal' }} />
        <Stack.Screen name="ride/[id]" options={{ title: 'Ride' }} />
        <Stack.Screen name="proposal/new" options={{ title: 'New proposal', presentation: 'modal' }} />
      </Stack>
    </GestureHandlerRootView>
  );
}
