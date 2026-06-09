import * as React from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Asset } from 'expo-asset';
import { TerminalSink } from '@/hooks/useTerminal';

export interface TerminalViewHandle { sink: TerminalSink; fit: () => void; focus: () => void; }
export interface TerminalViewProps {
    onInput: (data: string) => void;
    onResize: (cols: number, rows: number) => void;
    onReady: (handle: TerminalViewHandle) => void;
}

// Bundled via app.config.js assetBundlePatterns; loaded as a local file URI.
const html = require('../../../assets/terminal/index.html');

export const TerminalView = React.memo((props: TerminalViewProps) => {
    const ref = React.useRef<WebView>(null);
    const [uri, setUri] = React.useState<string | null>(null);

    React.useEffect(() => {
        (async () => {
            const asset = Asset.fromModule(html);
            await asset.downloadAsync();
            setUri(asset.localUri || asset.uri);
        })();
    }, []);

    const postToTerminal = React.useCallback((msg: object) => {
        ref.current?.postMessage(JSON.stringify(msg));
    }, []);

    const handle = React.useMemo<TerminalViewHandle>(() => ({
        sink: {
            write: (d) => postToTerminal({ type: 'write', data: d }),
            reset: () => postToTerminal({ type: 'clear' }),
        },
        fit: () => postToTerminal({ type: 'fit' }),
        focus: () => postToTerminal({ type: 'focus' }),
    }), [postToTerminal]);

    const onMessage = React.useCallback((e: { nativeEvent: { data: string } }) => {
        try {
            const m = JSON.parse(e.nativeEvent.data);
            if (m.type === 'input') props.onInput(m.data);
            else if (m.type === 'resize') props.onResize(m.cols, m.rows);
        } catch { /* ignore */ }
    }, [props]);

    if (!uri) return <View style={{ flex: 1, backgroundColor: '#000' }} />;
    return (
        <WebView
            ref={ref}
            source={{ uri }}
            originWhitelist={['*']}
            style={{ flex: 1, backgroundColor: '#000' }}
            keyboardDisplayRequiresUserAction={false}
            onLoadEnd={() => props.onReady(handle)}
            onMessage={onMessage}
            hideKeyboardAccessoryView
            javaScriptEnabled
        />
    );
});
