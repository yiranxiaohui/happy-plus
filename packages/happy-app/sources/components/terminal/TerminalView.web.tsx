import * as React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalViewHandle, TerminalViewProps } from './TerminalView';

export const TerminalView = React.memo((props: TerminalViewProps) => {
    const containerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (!containerRef.current) return;
        const term = new Terminal({ convertEol: false, cursorBlink: true, fontFamily: 'monospace', fontSize: 13, theme: { background: '#000000' } });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(containerRef.current);
        fit.fit();
        const handle: TerminalViewHandle = {
            sink: { write: (d) => term.write(d), reset: () => term.reset() },
            fit: () => { try { fit.fit(); } catch { /* */ } props.onResize(term.cols, term.rows); },
            focus: () => term.focus(),
        };
        const inDisp = term.onData((d) => props.onInput(d));
        const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* */ } props.onResize(term.cols, term.rows); });
        ro.observe(containerRef.current);
        props.onResize(term.cols, term.rows);
        props.onReady(handle);
        return () => { inDisp.dispose(); ro.disconnect(); term.dispose(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return <div ref={containerRef} style={{ width: '100%', height: '100%', background: '#000' }} />;
});
