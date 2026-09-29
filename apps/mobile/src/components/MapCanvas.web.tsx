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
  // Pad the bounds by roughly 3 km so a tap can reach a realistic trip length.
  const PAD = 0.03;
  const minLat = Math.min(...lats, centre?.lat ?? 0) - PAD;
  const maxLat = Math.max(...lats, centre?.lat ?? 0) + PAD;
  const minLng = Math.min(...lngs, centre?.lng ?? 0) - PAD;
  const maxLng = Math.max(...lngs, centre?.lng ?? 0) + PAD;
  const pct = (v: number, min: number, max: number) => ((v - min) / (max - min || 1)) * 100;

  return (
    <Pressable
      style={[styles.wrap, style]}
      onPress={(e) => {
        // On the web the press event is a DOM event; work out where in the box it landed.
        const ne = e.nativeEvent as unknown as {
          locationX?: number;
          locationY?: number;
          pageX?: number;
          pageY?: number;
          changedTouches?: Array<{ pageX: number; pageY: number }>;
        };
        const el = e.currentTarget as unknown as { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number } };
        const rect = el?.getBoundingClientRect?.();
        const w = rect?.width ?? 0;
        const h = rect?.height ?? 0;
        let x = ne.locationX;
        let y = ne.locationY;
        if (!(x != null && x >= 0) && rect) {
          const px = ne.pageX ?? ne.changedTouches?.[0]?.pageX;
          const py = ne.pageY ?? ne.changedTouches?.[0]?.pageY;
          const sx = typeof window !== 'undefined' ? window.scrollX : 0;
          const sy = typeof window !== 'undefined' ? window.scrollY : 0;
          if (px != null && py != null) {
            x = px - rect.left - sx;
            y = py - rect.top - sy;
          }
        }
        if (x == null || y == null || !(w > 0) || !(h > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
        onPress?.({
          lat: maxLat - (y / h) * (maxLat - minLat),
          lng: minLng + (x / w) * (maxLng - minLng),
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
