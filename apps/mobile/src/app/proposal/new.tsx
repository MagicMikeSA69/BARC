import React, { useState } from 'react';
import { router } from 'expo-router';
import { Banner, Button, Chip, Field, Muted, Row, Screen, Title } from '@/components/ui.tsx';
import { useApp } from '@/lib/store.ts';
import { space } from '@/lib/theme.ts';

export default function NewProposal() {
  const api = useApp((s) => s.api);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createProposal({ title: title.trim(), body: body.trim(), days });
      router.back();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title sub="Anything about how this node runs: the community fund, safety rules, who can join, what to build next. Every member gets one vote.">
        Propose
      </Title>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <Field label="Title" value={title} onChangeText={setTitle} placeholder="Lower the community fund to 1%" />
      <Field label="Proposal" value={body} onChangeText={setBody} multiline numberOfLines={6} placeholder="What should change, why, and what it means for drivers and riders." style={{ minHeight: 120 }} />
      <Muted style={{ marginBottom: space.xs }}>Voting period</Muted>
      <Row style={{ flexWrap: 'wrap', marginBottom: space.md }}>
        {[3, 7, 14, 30].map((d) => (
          <Chip key={d} label={`${d} days`} active={days === d} onPress={() => setDays(d)} />
        ))}
      </Row>
      <Button title="Put it to a vote" onPress={submit} loading={busy} disabled={title.trim().length < 4 || body.trim().length < 10} />
    </Screen>
  );
}
