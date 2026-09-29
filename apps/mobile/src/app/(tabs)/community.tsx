import React, { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { PRINCIPLES, type Proposal, type VoteChoice } from '@barc/shared';
import { Banner, Body, Button, Card, Chip, H2, Loading, Muted, Row, Screen, Title } from '@/components/ui.tsx';
import { useApp } from '@/lib/store.ts';
import { colors, space } from '@/lib/theme.ts';

export default function Community() {
  const api = useApp((s) => s.api);
  const node = useApp((s) => s.node);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [members, setMembers] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .proposals()
      .then((r) => {
        setProposals(r.proposals);
        setMembers(r.members);
      })
      .catch((e) => setError((e as Error).message));
  }, [api]);

  useFocusEffect(load);

  const vote = async (id: string, choice: VoteChoice) => {
    setBusy(id);
    try {
      const { proposal } = await api.vote(id, choice);
      setProposals((ps) => (ps ?? []).map((p) => (p.id === id ? proposal : p)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <Title sub={node ? `${node.name}. ${members} members, one vote each.` : 'Your node'}>Community</Title>
      {node ? (
        <Card>
          <Body>{node.description}</Body>
          <Muted style={{ marginTop: space.sm }}>
            Network take: {Math.round(node.networkTakeRate * 100)}% (fixed by protocol). Community fund: {(node.communityContributionRate * 100).toFixed(1)}%
            (set by vote, capped at 5%). Protocol v{node.protocolVersion}.
          </Muted>
        </Card>
      ) : null}
      {error ? <Banner tone="error">{error}</Banner> : null}

      <Row style={{ justifyContent: 'space-between' }}>
        <H2>Proposals</H2>
        <Button title="Propose" variant="secondary" onPress={() => router.push('/proposal/new')} style={{ minHeight: 36, paddingVertical: 6 }} />
      </Row>
      {proposals === null ? (
        <Loading />
      ) : proposals.length === 0 ? (
        <Card>
          <Body>Nothing on the table. Raise the first proposal: a fee change, a rule, a feature, anything.</Body>
        </Card>
      ) : (
        proposals.map((p) => {
          const closed = new Date(p.closesAt).getTime() < Date.now();
          const total = p.yes + p.no + p.abstain;
          return (
            <Card key={p.id}>
              <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>{p.title}</Text>
              <Muted>
                by {p.authorName} · {closed ? 'closed' : `closes ${new Date(p.closesAt).toLocaleDateString()}`}
              </Muted>
              <Body style={{ marginVertical: space.sm }}>{p.body}</Body>
              <View style={{ height: 8, backgroundColor: colors.line, borderRadius: 4, overflow: 'hidden', flexDirection: 'row' }}>
                <View style={{ flex: p.yes, backgroundColor: colors.success }} />
                <View style={{ flex: p.no, backgroundColor: colors.danger }} />
                <View style={{ flex: p.abstain, backgroundColor: colors.muted }} />
                <View style={{ flex: total === 0 ? 1 : 0 }} />
              </View>
              <Muted style={{ marginTop: space.xs }}>
                {p.yes} yes · {p.no} no · {p.abstain} abstain{p.myVote ? ` · you voted ${p.myVote}` : ''}
              </Muted>
              {!closed ? (
                <Row style={{ marginTop: space.sm, flexWrap: 'wrap' }}>
                  {(['yes', 'no', 'abstain'] as VoteChoice[]).map((c) => (
                    <Chip key={c} label={c} active={p.myVote === c} onPress={() => busy !== p.id && vote(p.id, c)} />
                  ))}
                </Row>
              ) : null}
            </Card>
          );
        })
      )}

      <H2>What we agree on</H2>
      {PRINCIPLES.map((p) => (
        <Card key={p.title}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 2 }}>{p.title}</Text>
          <Muted>{p.body}</Muted>
        </Card>
      ))}
    </Screen>
  );
}
