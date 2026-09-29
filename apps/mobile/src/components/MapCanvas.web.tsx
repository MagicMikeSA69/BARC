import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MapCanvasProps } from './MapCanvas.tsx';
import { colors } from '@/lib/theme.ts';

/**
 * Web fallback. react-native-maps is native only, so on the web we draw a
 * simple schematic: pins on a relative grid. Tapping places a point, which
 * is enough to exercise the flow in a browser during development.
 */
export default function MapCanvas({ centre, pins, onPress, style }: MapCanvasProps) {
  const all = [...pins, ...(centre ? [{ ...centre, id: 'c', kind: 'me' as const }] : [])];
  const lats = all.map((p) => p.lat);
  const lngs = all.map((p) => p.lng);
  const minLat = Math.min(...lats, centre?.lat ?? 0) - 0.01;
  const maxLat = Math.max(...lats, centre?.lat ?? 0) + 0.01;
  const minLng = Math.min(...lngs, centre?.lng ?? 0) - 0.01;
  const maxLng = Math.max(...lngs, centre?.lng ?? 0) + 0.01;
  const pct = (v: number, min: number, max: number) => ((v - min) / (max - min || 1)) * 100;

  return (
    <Pressable
      style={[styles.wrap, style]}
      onPress={(e) => {
        const { locationX, locationY } = e.nativeEvent;
        const target = e.currentTarget as unknown as { offsetWidth?: number; offsetHeight?: number };
        const w = target?.offsetWidth ?? 320;
        const h = target?.offsetHeight ?? 260;
        onPress?.({
          lat: maxLat - (locationY / h) * (maxLat - minLat),
          lng: minLng + (locationX / w) * (maxLng - minLng),
        });
      }}
    >
      <Text style={styles.note}>Schematic map (web preview). Tap to place a point. Real maps render on Android and iOS.</Text>
      {pins.map((p) => (
        <View
          key={p.id}
          style={[
            styles.pin,
            { left: `${pct(p.lng, minLng, maxLng)}%`, top: `${100 - pct(p.lat, minLat, maxLat)}%`, backgroundColor: p.kind === 'dropoff' ? colors.danger : p.kind === 'pickup' ? colors.accent : colors.primary },
          ]}
        >
          <Text style={styles.pinText}>{p.title ?? p.kind}</Text>
        </View>
      ))}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { height: 260, borderRadius: 16, overflow: 'hidden', backgroundColor: '#E8EEEA', position: 'relative' },
  note: { position: 'absolute', bottom: 8, left: 8, right: 8, fontSize: 11, color: colors.muted },
  pin: { position: 'absolute', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, transform: [{ translateX: -20 }, { translateY: -12 }] },
  pinText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
