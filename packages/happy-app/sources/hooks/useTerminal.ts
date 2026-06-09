import * as React from 'react';
import { apiSocket } from '@/sync/apiSocket';

export interface TerminalSink {
    write: (data: string) => void;   // write bytes to the xterm instance
    reset: () => void;               // clear the xterm instance (before scrollback replay)
}

export interface TerminalControllerOpts {
    machineId: string;
    cols: number;
    rows: number;
    cwd?: string;
    shell?: string;
    terminalId?: string;             // when resuming an existing terminal
}

/**
 * Owns one terminal's data flow, independent of React, so it can be unit-tested.
 * - start(): create (or attach to) a terminal, subscribe to output/exit.
 * - write(): send user input.
 * - resize(): notify daemon of viewport changes.
 * - dispose(): unsubscribe (PTY stays alive on the daemon — tmux-like).
 * Detects dropped output via the monotonic seq and re-attaches, replaying the
 * server-held scrollback after reset().
 */
export class TerminalController {
    terminalId: string | null = null;
    private lastSeq = 0;
    private unsub: Array<() => void> = [];
    private reattaching = false;
    onExit?: (exitCode: number) => void;

    constructor(private opts: TerminalControllerOpts, private sink: TerminalSink) {
        this.terminalId = opts.terminalId ?? null;
    }

    async start(): Promise<void> {
        this.subscribe();
        if (this.terminalId) {
            await this.reattach();
        } else {
            const { terminalId } = await (await import('@/sync/ops')).terminalCreate({
                machineId: this.opts.machineId, cols: this.opts.cols, rows: this.opts.rows,
                cwd: this.opts.cwd, shell: this.opts.shell,
            });
            this.terminalId = terminalId;
            this.lastSeq = 0;
        }
    }

    private subscribe(): void {
        this.unsub.push(apiSocket.onTerminalOutput((e) => {
            if (e.machineId !== this.opts.machineId || e.terminalId !== this.terminalId) return;
            if (e.seq > this.lastSeq + 1 && this.lastSeq !== 0) {
                void this.reattach();
                return;
            }
            this.lastSeq = e.seq;
            this.sink.write(e.output);
        }));
        this.unsub.push(apiSocket.onTerminalExit((e) => {
            if (e.machineId !== this.opts.machineId || e.terminalId !== this.terminalId) return;
            this.onExit?.(e.exitCode);
        }));
    }

    private async reattach(): Promise<void> {
        if (this.reattaching || !this.terminalId) return;
        this.reattaching = true;
        try {
            const r = await (await import('@/sync/ops')).terminalAttach(this.opts.machineId, this.terminalId);
            this.sink.reset();
            this.sink.write(r.scrollback);
            this.lastSeq = 0;
        } finally {
            this.reattaching = false;
        }
    }

    async write(input: string): Promise<void> {
        if (!this.terminalId) return;
        await apiSocket.terminalSendInput(this.opts.machineId, this.terminalId, input);
    }

    resize(cols: number, rows: number): void {
        if (!this.terminalId) return;
        apiSocket.terminalSendResize(this.opts.machineId, this.terminalId, cols, rows);
    }

    dispose(): void {
        for (const u of this.unsub) u();
        this.unsub = [];
    }
}

/** React wrapper around TerminalController. */
export function useTerminal(opts: TerminalControllerOpts, sink: TerminalSink) {
    const ctrlRef = React.useRef<TerminalController | null>(null);
    const [ready, setReady] = React.useState(false);
    const [exitCode, setExitCode] = React.useState<number | null>(null);

    React.useEffect(() => {
        const ctrl = new TerminalController(opts, sink);
        ctrl.onExit = (code) => setExitCode(code);
        ctrlRef.current = ctrl;
        ctrl.start().then(() => setReady(true)).catch(() => setReady(false));
        return () => ctrl.dispose();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opts.machineId, opts.terminalId]);

    return {
        ready,
        exitCode,
        write: (data: string) => ctrlRef.current?.write(data),
        resize: (cols: number, rows: number) => ctrlRef.current?.resize(cols, rows),
        terminalId: () => ctrlRef.current?.terminalId ?? null,
    };
}
