import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatMoney, type RideRequest } from '@barc/shared';
import { Card, Muted, Row } from './ui.tsx';
import { colors, radius, space } from '@/lib/theme.ts';

export const STATUS_LABEL: Record<RideRequest['status'], string> = {
  open: 'Waiting for offers',
  accepted: 'Driver on the way',
  arrived: 'Driver has arrived',
  in_progress: 'On the road',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const STATUS_COLOUR: Record<RideRequest['status'], string> = {
  open: colors.accent,
  accepted: colors.primary,
  arrived: colors.primary,
  in_progress: colors.primaryDark,
  completed: colors.success,
  cancelled: colors.muted,
};

export function StatusPill({ status }: { status: RideRequest['status'] }) {
  return (
    <View style={{ backgroundColor: STATUS_COLOUR[status], paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill }}>
      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{STATUS_LABEL[status]}</Text>
    </View>
  );
}

export function RideCard({ ride, onPress, extra }: { ride: RideRequest; onPress?: () => void; extra?: React.ReactNode }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      <Card>
        <Row style={{ justifyContent: 'space-between', marginBottom: space.sm }}>
          <StatusPill status={ride.status} />
          <Muted>{new Date(ride.createdAt).toLocaleString()}</Muted>
        </Row>
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
          {ride.pickup.label} → {ride.dropoff.label}
        </Text>
        <Muted>
          ~{ride.estimatedKm} km · ~{ride.estimatedMin} min · {ride.seats} seat{ride.seats === 1 ? '' : 's'}
          {ride.agreedFare != null ? ` · ${formatMoney(ride.agreedFare, ride.currency)}` : ''}
        </Muted>
        {extra}
      </Card>
    </Pressable>
  );
}
