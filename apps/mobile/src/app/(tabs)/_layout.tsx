import React from 'react';
import type { ColorValue } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/lib/theme.ts';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

const icon =
  (name: IconName): ((p: { color: ColorValue; size: number }) => React.ReactElement) =>
  ({ color, size }) => <Ionicons name={name} color={color} size={size} />;

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.line },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: icon('car-outline') }} />
      <Tabs.Screen name="rides" options={{ title: 'Rides', tabBarIcon: icon('time-outline') }} />
      <Tabs.Screen name="community" options={{ title: 'Community', tabBarIcon: icon('people-outline') }} />
      <Tabs.Screen name="profile" options={{ title: 'Me', tabBarIcon: icon('person-circle-outline') }} />
    </Tabs>
  );
}
