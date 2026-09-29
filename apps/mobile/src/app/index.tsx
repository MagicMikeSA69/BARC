import React from 'react';
import { Redirect } from 'expo-router';
import { useApp } from '@/lib/store.ts';
import { Loading, Screen } from '@/components/ui.tsx';

export default function Index() {
  const ready = useApp((s) => s.ready);
  const session = useApp((s) => s.session);
  if (!ready) {
    return (
      <Screen scroll={false}>
        <Loading label="Starting BARC" />
      </Screen>
    );
  }
  return <Redirect href={session ? '/(tabs)' : '/onboarding'} />;
}
