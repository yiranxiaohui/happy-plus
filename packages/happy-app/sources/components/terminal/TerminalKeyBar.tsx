import * as React from 'react';
import { View, Pressable, Text, ScrollView, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

// Maps a label to the raw bytes written to the PTY.
const KEYS: Array<{ label: string; seq: string }> = [
    { label: 'esc', seq: '\x1b' },
    { label: 'tab', seq: '\t' },
    { label: 'ctrl-c', seq: '\x03' },
    { label: 'ctrl-d', seq: '\x04' },
    { label: 'ctrl-z', seq: '\x1a' },
    { label: 'ctrl-l', seq: '\x0c' },
    { label: '↑', seq: '\x1b[A' },
    { label: '↓', seq: '\x1b[B' },
    { label: '←', seq: '\x1b[D' },
    { label: '→', seq: '\x1b[C' },
    { label: '|', seq: '|' },
    { label: '/', seq: '/' },
    { label: '~', seq: '~' },
];

export const TerminalKeyBar = React.memo(({ onKey }: { onKey: (seq: string) => void }) => {
    // Only useful where the soft keyboard lacks these keys.
    if (Platform.OS === 'web') return null;
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={styles.bar}>
            {KEYS.map((k) => (
                <Pressable key={k.label} onPress={() => onKey(k.seq)} style={styles.key}>
                    <Text style={styles.keyText}>{k.label}</Text>
                </Pressable>
            ))}
        </ScrollView>
    );
});

const styles = StyleSheet.create((theme) => ({
    bar: { flexGrow: 0, backgroundColor: theme.colors.surfaceHigh, paddingVertical: 6, paddingHorizontal: 6 },
    key: { paddingHorizontal: 12, paddingVertical: 8, marginHorizontal: 3, borderRadius: 6, backgroundColor: theme.colors.groupped.background },
    keyText: { color: theme.colors.text, fontSize: 13, fontFamily: 'monospace' },
}));
