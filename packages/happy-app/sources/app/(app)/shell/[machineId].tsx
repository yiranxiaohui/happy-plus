import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useTerminal, TerminalSink } from '@/hooks/useTerminal';
import { TerminalView, TerminalViewHandle } from '@/components/terminal/TerminalView';
import { TerminalKeyBar } from '@/components/terminal/TerminalKeyBar';
import { HeaderBackButton } from '@/components/HeaderBackButton';
import { t } from '@/text';

export default React.memo(() => {
    const params = useLocalSearchParams<{ machineId: string; cwd?: string; terminalId?: string }>();
    const machineId = params.machineId!;
    const handleRef = React.useRef<TerminalViewHandle | null>(null);
    const [cols, setCols] = React.useState(80);
    const [rows, setRows] = React.useState(24);

    const sink = React.useMemo<TerminalSink>(() => ({
        write: (d) => handleRef.current?.sink.write(d),
        reset: () => handleRef.current?.sink.reset(),
    }), []);

    const term = useTerminal(
        { machineId, cols, rows, cwd: params.cwd, terminalId: params.terminalId },
        sink,
    );

    return (
        <View style={{ flex: 1, backgroundColor: '#000' }}>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('terminal.title'), headerLeft: () => <HeaderBackButton fallback={`/machine/${machineId}`} /> }} />
            <TerminalView
                onReady={(h) => { handleRef.current = h; h.focus(); }}
                onInput={(d) => term.write(d)}
                onResize={(c, r) => { setCols(c); setRows(r); term.resize(c, r); }}
            />
            <TerminalKeyBar onKey={(seq) => term.write(seq)} />
        </View>
    );
});
