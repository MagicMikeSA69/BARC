import React, { useState } from 'react';
import { Text } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { formatMoney, suggestedRatesFor, validateRates, type DriverRates, type Role, type Vehicle } from '@barc/shared';
import { Banner, Button, Card, Chip, ConfirmButton, Field, H2, Muted, Row, Screen, Stars, Title } from '@/components/ui.tsx';
import { useApp, useUser } from '@/lib/store.ts';
import { colors, space } from '@/lib/theme.ts';

const num = (s: string) => {
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

export default function Profile() {
  const user = useUser();
  const api = useApp((s) => s.api);
  const node = useApp((s) => s.node);
  const session = useApp((s) => s.session);
  const setUser = useApp((s) => s.setUser);
  const signOut = useApp((s) => s.signOut);

  const currency = user?.rates?.currency ?? node?.currency ?? 'USD';
  const seed: DriverRates = user?.rates ?? { ...suggestedRatesFor(currency) };
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'rider');
  const [paymentHandle, setPaymentHandle] = useState(user?.paymentHandle ?? '');
  const [base, setBase] = useState(String(seed.base));
  const [perKm, setPerKm] = useState(String(seed.perKm));
  const [perMin, setPerMin] = useState(String(seed.perMin));
  const [minimum, setMinimum] = useState(String(seed.minimum));
  const [vehicle, setVehicle] = useState<Vehicle>(user?.vehicle ?? { make: '', model: '', colour: '', plate: '', seats: 4 });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  if (!user) return null;
  const driving = role === 'driver' || role === 'both';

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const rates: DriverRates | null = driving
        ? { base: num(base), perKm: num(perKm), perMin: num(perMin), minimum: num(minimum), currency }
        : null;
      if (driving && !validateRates(rates)) throw new Error('Rates must be numbers of zero or more.');
      const { user: updated } = await api.updateMe({ displayName, role, paymentHandle, rates, vehicle: driving ? vehicle : null });
      setUser(updated);
      setMsg({ tone: 'success', text: 'Saved.' });
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const [exported, setExported] = useState<string | null>(null);
  const exportData = async () => {
    try {
      const json = JSON.stringify(await api.exportMe(), null, 2);
      setExported(json);
      try {
        await Clipboard.setStringAsync(json);
        setMsg({ tone: 'success', text: 'Your profile, ratings and ride history are on the clipboard as JSON.' });
      } catch {
        setMsg({ tone: 'success', text: 'Your data is shown below. Select it to copy.' });
      }
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    }
  };

  const leave = async () => {
    await signOut();
    router.replace('/onboarding');
  };

  const preview = driving && validateRates({ base: num(base), perKm: num(perKm), perMin: num(perMin), minimum: num(minimum), currency })
    ? formatMoney(Math.max(num(minimum), num(base) + num(perKm) * 10 + num(perMin) * 20), currency)
    : null;

  return (
    <Screen>
      <Title sub={`@${user.handle} on ${session?.nodeUrl ?? ''}`}>{user.displayName}</Title>
      <Card>
        <Stars value={user.ratingAvg} count={user.ratingCount} />
        <Muted>{user.ridesCompleted} trips completed · member since {new Date(user.createdAt).toLocaleDateString()}</Muted>
      </Card>
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}

      <H2>About you</H2>
      <Field label="Name people see" value={displayName} onChangeText={setDisplayName} />
      <Field
        label="How riders pay you / how you pay"
        value={paymentHandle}
        onChangeText={setPaymentHandle}
        placeholder="Cash, SnapScan 07x, M-Pesa, bank transfer…"
        hint="Shared with the other person only once you have agreed a ride. BARC never touches the money."
      />
      <Row style={{ flexWrap: 'wrap', marginBottom: space.sm }}>
        {(['rider', 'driver', 'both'] as Role[]).map((r) => (
          <Chip key={r} label={r} active={role === r} onPress={() => setRole(r)} />
        ))}
      </Row>

      {driving ? (
        <>
          <H2>Your rate card ({currency})</H2>
          <Muted style={{ marginBottom: space.sm }}>
            This is your price. Riders see it before they request, and you can quote differently on any single trip. No surge is ever applied on top.
          </Muted>
          <Row style={{ gap: space.sm }}>
            <Field label="Base" value={base} onChangeText={setBase} keyboardType="decimal-pad" style={{ flex: 1 }} />
            <Field label="Per km" value={perKm} onChangeText={setPerKm} keyboardType="decimal-pad" style={{ flex: 1 }} />
          </Row>
          <Row style={{ gap: space.sm }}>
            <Field label="Per minute" value={perMin} onChangeText={setPerMin} keyboardType="decimal-pad" style={{ flex: 1 }} />
            <Field label="Minimum" value={minimum} onChangeText={setMinimum} keyboardType="decimal-pad" style={{ flex: 1 }} />
          </Row>
          {preview ? <Muted style={{ marginBottom: space.md }}>A 10 km, 20 minute trip would be {preview}.</Muted> : null}

          <H2>Your car</H2>
          <Row style={{ gap: space.sm }}>
            <Field label="Make" value={vehicle.make} onChangeText={(v) => setVehicle({ ...vehicle, make: v })} style={{ flex: 1 }} />
            <Field label="Model" value={vehicle.model} onChangeText={(v) => setVehicle({ ...vehicle, model: v })} style={{ flex: 1 }} />
          </Row>
          <Row style={{ gap: space.sm }}>
            <Field label="Colour" value={vehicle.colour} onChangeText={(v) => setVehicle({ ...vehicle, colour: v })} style={{ flex: 1 }} />
            <Field label="Plate" value={vehicle.plate} onChangeText={(v) => setVehicle({ ...vehicle, plate: v })} autoCapitalize="characters" style={{ flex: 1 }} />
          </Row>
          <Field
            label="Seats for passengers"
            value={String(vehicle.seats)}
            onChangeText={(v) => setVehicle({ ...vehicle, seats: Math.max(1, Math.min(12, Math.round(num(v) || 1))) })}
            keyboardType="number-pad"
          />
        </>
      ) : null}

      <Button title="Save" onPress={save} loading={busy} />

      <H2>Your data</H2>
      <Card>
        <Text style={{ fontSize: 15, color: colors.text, marginBottom: space.sm }}>
          Ratings and history belong to you, not the node. Export them any time and take them elsewhere.
        </Text>
        <Button title="Export my data (JSON)" variant="secondary" onPress={exportData} />
        {exported ? (
          <Text selectable style={{ fontFamily: 'monospace', fontSize: 11, color: colors.muted, marginTop: space.md }} numberOfLines={12}>
            {exported}
          </Text>
        ) : null}
      </Card>
      <ConfirmButton
        title="Sign out"
        question="Sign out? Your membership stays on the node. Export your data first if you want a copy."
        confirmTitle="Sign out"
        onConfirm={leave}
      />
    </Screen>
  );
}
