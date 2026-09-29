import React, { useEffect, useRef } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_DEFAULT, type Region } from 'react-native-maps';
import type { LatLng } from '@barc/shared';
import { colors } from '@/lib/theme.ts';

export interface MapPin extends LatLng {
  id: string;
  title?: string;
  kind: 'me' | 'pickup' | 'dropoff' | 'driver';
}

export interface MapCanvasProps {
  centre: LatLng | null;
  pins: MapPin[];
  line?: LatLng[];
  onPress?: (p: LatLng) => void;
  onLongPress?: (p: LatLng) => void;
  showsUserLocation?: boolean;
  style?: StyleProp<ViewStyle>;
}

const PIN_COLOURS: Record<MapPin['kind'], string> = {
  me: colors.primary,
  pickup: colors.accent,
  dropoff: colors.danger,
  driver: colors.primaryDark,
};

/** Native map. Uses Apple Maps on iOS and Google Maps on Android (key in app.json). */
export default function MapCanvas({ centre, pins, line, onPress, onLongPress, showsUserLocation, style }: MapCanvasProps) {
  const ref = useRef<MapView>(null);
  const initial: Region = {
    latitude: centre?.lat ?? 0,
    longitude: centre?.lng ?? 0,
    latitudeDelta: 0.05,
    longitudeDelta: 0.05,
  };

  useEffect(() => {
    const pts = [...pins, ...(line ?? [])];
    if (pts.length >= 2) {
      ref.current?.fitToCoordinates(
        pts.map((p) => ({ latitude: p.lat, longitude: p.lng })),
        { edgePadding: { top: 60, right: 60, bottom: 60, left: 60 }, animated: true },
      );
    } else if (pts.length === 1 || centre) {
      const c = pts[0] ?? centre!;
      ref.current?.animateToRegion({ latitude: c.lat, longitude: c.lng, latitudeDelta: 0.03, longitudeDelta: 0.03 }, 400);
    }
    // Only re-fit when the set of points changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(pins.map((p) => [p.lat, p.lng])), line?.length, centre?.lat, centre?.lng]);

  return (
    <View style={[styles.wrap, style]}>
      <MapView
        ref={ref}
        provider={PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={initial}
        showsUserLocation={showsUserLocation}
        showsMyLocationButton
        onPress={(e) => onPress?.({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude })}
        onLongPress={(e) => onLongPress?.({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude })}
      >
        {pins.map((p) => (
          <Marker
            key={p.id}
            coordinate={{ latitude: p.lat, longitude: p.lng }}
            title={p.title}
            pinColor={PIN_COLOURS[p.kind]}
          />
        ))}
        {line && line.length >= 2 ? (
          <Polyline coordinates={line.map((p) => ({ latitude: p.lat, longitude: p.lng }))} strokeColor={colors.primary} strokeWidth={4} />
        ) : null}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: 260, borderRadius: 16, overflow: 'hidden', backgroundColor: colors.line },
});
