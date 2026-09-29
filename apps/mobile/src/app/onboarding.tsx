import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { PRINCIPLES, type Role } from '@barc/shared';
import { Banner, Body, Button, Card, Chip, Field, H2, Muted, Row, Screen, Title } from '@/components/ui.tsx';
import { defaultNodeUrl, useApp } from '@/lib/store.ts';
import { DEMO_NODE_URL } from '@/lib/api.ts';
import { colors, space } from '@/lib/theme.ts';

const ROLES: Array<{ key: Role; label: string; blurb: string }> = [
  { key: 'rider', label: 'I ride', blurb: 'Request trips, compare offers, choose your driver.' },
  { key: 'driver', label: 'I drive', blurb: 'Set your own rates, pick the trips you want, keep 100%.' },
  { key: 'both', label: 'Both', blurb: 'Drive some days, ride on others.' },
];

export default function Onboarding() {
  const join = useApp((s) => s.join);
  const [step, setStep] = useState<'intro' | 'join'>('intro');
  const [nodeUrl, setNodeUrl] = useState(defaultNodeUrl);
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('rider');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await join(nodeUrl, { handle: handle.trim().toLowerCase(), displayName: displayName.trim(), role });
      router.replace('/(tabs)');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'intro') {
    return (
      <Screen>
        <View style={{ paddingVertical: space.xl }}>
          <Text style={{ fontSize: 44, fontWeight: '900', color: colors.primaryDark, letterSpacing: -1 }}>BARC</Text>
          <Text style={{ fontSize: 20, color: colors.text, fontWeight: '600', marginTop: space.xs }}>Rides by people, for people.</Text>
          <Muted style={{ marginTop: space.sm }}>
            No company in the middle. Drivers set their prices, riders pick their drivers, and the community runs the network.
          </Muted>
        </View>
        {PRINCIPLES.map((p) => (
          <Card key={p.title}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 4 }}>{p.title}</Text>
            <Body>{p.body}</Body>
          </Card>
        ))}
        <Button
          title="Try the demo"
          onPress={() => {
            setNodeUrl(DEMO_NODE_URL);
            setStep('join');
          }}
          style={{ marginTop: space.md }}
        />
        <Button title="Join a real node" variant="secondary" onPress={() => setStep('join')} style={{ marginTop: space.sm }} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title sub="A node is a community server. Anyone can run one. Ask your local group for theirs, or use the default.">
        Join
      </Title>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {nodeUrl === DEMO_NODE_URL ? (
        <Banner tone="success">
          Demo node: a simulated town runs inside the app and nothing leaves your device. Pick "I ride" to request a trip and watch offers arrive, or "I drive" to receive a request.
        </Banner>
      ) : null}
      <Field
        label="Node address"
        value={nodeUrl}
        onChangeText={setNodeUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://rides.mytown.example"
        hint={nodeUrl === DEMO_NODE_URL ? undefined : 'Or type demo://local to try the built-in demo.'}
      />
      <Field label="Handle" value={handle} onChangeText={setHandle} autoCapitalize="none" autoCorrect={false} placeholder="thandi_m" hint="3-24 letters, numbers or underscores. Unique on this node." />
      <Field label="Name people see" value={displayName} onChangeText={setDisplayName} placeholder="Thandi" />
      <H2>How will you use BARC?</H2>
      <Row style={{ flexWrap: 'wrap' }}>
        {ROLES.map((r) => (
          <Chip key={r.key} label={r.label} active={role === r.key} onPress={() => setRole(r.key)} />
        ))}
      </Row>
      <Muted style={{ marginBottom: space.lg }}>{ROLES.find((r) => r.key === role)?.blurb}</Muted>
      <Button title="Create my membership" onPress={submit} loading={busy} disabled={!handle || !displayName || !nodeUrl} />
      <Button title="Back" variant="ghost" onPress={() => setStep('intro')} style={{ marginTop: space.sm }} />
    </Screen>
  );
}
