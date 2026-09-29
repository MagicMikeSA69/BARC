import React from 'react';
import { Text } from 'react-native';
import { formatMoney, type Offer } from '@barc/shared';
import { Button, Card, Muted, Row, Stars } from './ui.tsx';
import { colors, space } from '@/lib/theme.ts';

export function OfferCard({ offer, onAccept, busy }: { offer: Offer; onAccept?: () => void; busy?: boolean }) {
  const v = offer.driver.vehicle;
  const dim = offer.status !== 'pending';
  return (
    <Card style={{ opacity: dim ? 0.55 : 1 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>{offer.driver.displayName}</Text>
        <Text style={{ fontSize: 22, fontWeight: '800', color: colors.primaryDark }}>{formatMoney(offer.fare, offer.currency)}</Text>
      </Row>
      <Stars value={offer.driver.ratingAvg} count={offer.driver.ratingCount} />
      <Muted>
        {offer.etaMin} min away · {offer.driver.ridesCompleted} trips
        {v ? ` · ${v.colour} ${v.make} ${v.model} (${v.plate})` : ''}
      </Muted>
      {offer.message ? <Muted style={{ fontStyle: 'italic', marginTop: space.xs }}>“{offer.message}”</Muted> : null}
      {offer.status !== 'pending' ? <Muted style={{ marginTop: space.xs }}>{offer.status}</Muted> : null}
      {onAccept && offer.status === 'pending' ? (
        <Button title="Choose this driver" onPress={onAccept} loading={busy} style={{ marginTop: space.md }} />
      ) : null}
    </Card>
  );
}
