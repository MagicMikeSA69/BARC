import { useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import type { LatLng } from '@barc/shared';

export interface Position extends LatLng {
  heading: number | null;
}

const POSITION_TIMEOUT_MS = 6000;

/**
 * Ask once for foreground location and return the current fix, or null if
 * the platform refuses or stays silent (some embedded browsers never answer).
 */
export async function getCurrentPosition(): Promise<Position | null> {
  const attempt = (async (): Promise<Position | null> => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, heading: pos.coords.heading ?? null };
  })();
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), POSITION_TIMEOUT_MS));
  try {
    return await Promise.race([attempt, timeout]);
  } catch {
    return null;
  }
}

/**
 * Follow the device position. `active` lets a driver stop sharing the
 * moment they go offline — sharing is always the member's choice.
 */
export function useLivePosition(active: boolean, onUpdate?: (p: Position) => void): Position | null {
  const [position, setPosition] = useState<Position | null>(null);
  const cb = useRef(onUpdate);
  cb.current = onUpdate;

  useEffect(() => {
    if (!active) return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      const first = await getCurrentPosition();
      if (cancelled) return;
      if (first) {
        setPosition(first);
        cb.current?.(first);
      }
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted' || cancelled) return;
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 15 },
          (pos) => {
            const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, heading: pos.coords.heading ?? null };
            setPosition(p);
            cb.current?.(p);
          },
        );
      } catch {
        /* no geolocation on this platform */
      }
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [active]);

  return position;
}

export async function labelFor(p: LatLng): Promise<string> {
  try {
    const [addr] = await Location.reverseGeocodeAsync({ latitude: p.lat, longitude: p.lng });
    if (!addr) return '';
    return [addr.name || addr.street, addr.district || addr.subregion || addr.city].filter(Boolean).join(', ');
  } catch {
    return '';
  }
}

export async function searchPlace(query: string): Promise<LatLng | null> {
  try {
    const [hit] = await Location.geocodeAsync(query);
    return hit ? { lat: hit.latitude, lng: hit.longitude } : null;
  } catch {
    return null;
  }
}
