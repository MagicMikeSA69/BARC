import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius, shadow, space } from '@/lib/theme.ts';

export function Screen({
  children,
  scroll = true,
  padded = true,
  style,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const inner = padded ? styles.padded : undefined;
  return (
    <SafeAreaView style={[styles.screen, style]} edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView contentContainerStyle={[inner, { paddingBottom: space.xxl }]} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, inner]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function Title({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <View style={{ marginBottom: space.lg }}>
      <Text style={styles.title}>{children}</Text>
      {sub ? <Text style={styles.sub}>{sub}</Text> : null}
    </View>
  );
}

export function H2({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <Text style={[styles.h2, style as object]}>{children}</Text>;
}

export function Muted({ children, style }: { children: React.ReactNode; style?: object }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

export function Body({ children, style }: { children: React.ReactNode; style?: object }) {
  return <Text style={[styles.body, style]}>{children}</Text>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Row({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  title,
  variant = 'primary',
  loading,
  disabled,
  style,
  ...rest
}: PressableProps & { title: string; variant?: Variant; loading?: boolean; style?: StyleProp<ViewStyle> }) {
  const bg =
    variant === 'primary' ? colors.primary : variant === 'danger' ? colors.danger : variant === 'secondary' ? colors.chip : 'transparent';
  const fg = variant === 'primary' || variant === 'danger' ? colors.primaryText : colors.primaryDark;
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={off}
      style={({ pressed }) => [styles.btn, { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.85 : 1 }, style]}
      {...rest}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[styles.btnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  style,
  ...rest
}: TextInputProps & { label: string; hint?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ marginBottom: space.md }, style]}>
      <Text style={styles.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.muted} style={styles.input} {...rest} />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress?: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={[styles.chip, active && { backgroundColor: colors.primary }]}
    >
      <Text style={[styles.chipText, active && { color: colors.primaryText }]}>{label}</Text>
    </Pressable>
  );
}

export function Banner({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: React.ReactNode }) {
  const bg = tone === 'error' ? '#FBE9E7' : tone === 'warn' ? '#FFF6DB' : tone === 'success' ? '#E3F5EA' : colors.chip;
  return (
    <View style={[styles.banner, { backgroundColor: bg }]}>
      <Text style={styles.body}>{children}</Text>
    </View>
  );
}

export function Stars({ value, count }: { value: number; count: number }) {
  if (!count) return <Muted>New member</Muted>;
  return (
    <Muted>
      ★ {value.toFixed(1)} · {count} rating{count === 1 ? '' : 's'}
    </Muted>
  );
}

export function StarPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Row style={{ justifyContent: 'center', gap: space.sm }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Pressable key={n} onPress={() => onChange(n)} accessibilityRole="button" accessibilityLabel={`${n} stars`}>
          <Text style={{ fontSize: 36, color: n <= value ? colors.accent : colors.line }}>★</Text>
        </Pressable>
      ))}
    </Row>
  );
}

/**
 * Two-step confirmation drawn in the page. Native alert dialogs are not
 * available everywhere the app runs, so the question is asked inline.
 */
export function ConfirmButton({
  title,
  question,
  confirmTitle,
  onConfirm,
  variant = 'ghost',
  loading,
  style,
}: {
  title: string;
  question: string;
  confirmTitle: string;
  onConfirm: () => void;
  variant?: Variant;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [asking, setAsking] = React.useState(false);
  if (!asking) return <Button title={title} variant={variant} onPress={() => setAsking(true)} style={style} />;
  return (
    <View style={[{ gap: space.sm }, style]}>
      <Text style={styles.body}>{question}</Text>
      <Row style={{ gap: space.sm }}>
        <Button title={confirmTitle} variant="danger" onPress={onConfirm} loading={loading} style={{ flex: 1 }} />
        <Button title="Keep" variant="secondary" onPress={() => setAsking(false)} style={{ flex: 1 }} />
      </Row>
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={{ padding: space.xl, alignItems: 'center', gap: space.sm }}>
      <ActivityIndicator color={colors.primary} />
      {label ? <Muted>{label}</Muted> : null}
    </View>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.hint}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  padded: { padding: space.lg },
  title: { fontSize: 28, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  sub: { fontSize: 15, color: colors.muted, marginTop: space.xs, lineHeight: 21 },
  h2: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: space.sm, marginTop: space.md },
  muted: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  body: { fontSize: 15, color: colors.text, lineHeight: 22 },
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: space.lg, marginBottom: space.md, ...shadow },
  row: { flexDirection: 'row', alignItems: 'center' },
  btn: { paddingVertical: 14, paddingHorizontal: space.lg, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', minHeight: 48 },
  btnText: { fontSize: 16, fontWeight: '700' },
  label: { fontSize: 13, fontWeight: '600', color: colors.muted, marginBottom: space.xs, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, padding: 12, fontSize: 16, color: colors.text },
  hint: { fontSize: 12, color: colors.muted, marginTop: space.xs },
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.chip, marginRight: space.sm, marginBottom: space.sm },
  chipText: { color: colors.primaryDark, fontWeight: '600' },
  banner: { padding: space.md, borderRadius: radius.sm, marginBottom: space.md },
  stat: { flex: 1, backgroundColor: colors.card, borderRadius: radius.md, padding: space.md, alignItems: 'center' },
  statValue: { fontSize: 22, fontWeight: '800', color: colors.primaryDark },
});
