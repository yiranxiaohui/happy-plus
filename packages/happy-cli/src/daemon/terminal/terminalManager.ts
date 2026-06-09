import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import * as os from 'os';

export const SCROLLBACK_BYTES = 256 * 1024;
export const MAX_TERMINALS = 20;

export interface TerminalCreateParams {
    cols: number;
    rows: number;
    cwd?: string;
    shell?: string;
}

export interface TerminalInfo {
    id: string;
    title: string;
    cwd: string;
    rows: number;
    cols: number;
    createdAt: number;
}

interface TerminalSession {
    id: string;
    pty: pty.IPty;
    scrollback: string;
    rows: number;
    cols: number;
    cwd: string;
    title: string;
    seq: number;
    createdAt: number;
    lastActivity: number;
}

type OutputListener = (terminalId: string, data: string, seq: number) => void;
type ExitListener = (terminalId: string, exitCode: number) => void;

let counter = 0;
function newId(): string {
    counter += 1;
    return `t_${Date.now().toString(36)}_${counter}`;
}

/**
 * Owns all PTY processes on this machine. PTYs persist across client
 * disconnects (tmux-like); they die only on shell exit, explicit close, or
 * daemon shutdown. Output is appended to a capped scrollback ring and pushed
 * to listeners with a monotonic per-terminal seq so clients can detect gaps.
 */
export class TerminalManager {
    private sessions = new Map<string, TerminalSession>();
    private outputListeners = new Set<OutputListener>();
    private exitListeners = new Set<ExitListener>();

    onOutput(fn: OutputListener): () => void {
        this.outputListeners.add(fn);
        return () => this.outputListeners.delete(fn);
    }

    onExit(fn: ExitListener): () => void {
        this.exitListeners.add(fn);
        return () => this.exitListeners.delete(fn);
    }

    create(params: TerminalCreateParams): { terminalId: string } {
        if (this.sessions.size >= MAX_TERMINALS) {
            throw new Error(`Terminal limit reached (${MAX_TERMINALS})`);
        }
        const shell = params.shell || process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash');
        const cwd = params.cwd && params.cwd.length > 0 ? params.cwd : os.homedir();
        const p = pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols: params.cols,
            rows: params.rows,
            cwd,
            env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
        });
        const id = newId();
        const session: TerminalSession = {
            id, pty: p, scrollback: '', rows: params.rows, cols: params.cols,
            cwd, title: shell.split('/').pop() || shell, seq: 0,
            createdAt: Date.now(), lastActivity: Date.now(),
        };
        this.sessions.set(id, session);

        p.onData((data: string) => {
            this.appendScrollback(id, data);
            session.seq += 1;
            session.lastActivity = Date.now();
            for (const fn of this.outputListeners) fn(id, data, session.seq);
        });
        p.onExit(({ exitCode }) => {
            for (const fn of this.exitListeners) fn(id, exitCode);
            this.sessions.delete(id);
        });
        return { terminalId: id };
    }

    write(terminalId: string, input: string): void {
        const s = this.sessions.get(terminalId);
        if (!s) return;
        s.lastActivity = Date.now();
        s.pty.write(input);
    }

    resize(terminalId: string, cols: number, rows: number): void {
        const s = this.sessions.get(terminalId);
        if (!s) return;
        s.cols = cols; s.rows = rows;
        try { s.pty.resize(cols, rows); } catch { /* pty may have exited */ }
    }

    close(terminalId: string): { ok: boolean } {
        const s = this.sessions.get(terminalId);
        if (!s) return { ok: false };
        try { s.pty.kill(); } catch { /* already dead */ }
        this.sessions.delete(terminalId);
        return { ok: true };
    }

    attach(terminalId: string): { scrollback: string; cols: number; rows: number; alive: boolean } | null {
        const s = this.sessions.get(terminalId);
        if (!s) return null;
        return { scrollback: s.scrollback, cols: s.cols, rows: s.rows, alive: true };
    }

    list(): { terminals: TerminalInfo[] } {
        return {
            terminals: [...this.sessions.values()].map((s) => ({
                id: s.id, title: s.title, cwd: s.cwd, rows: s.rows, cols: s.cols, createdAt: s.createdAt,
            })),
        };
    }

    shutdown(): void {
        for (const s of this.sessions.values()) {
            try { s.pty.kill(); } catch { /* ignore */ }
        }
        this.sessions.clear();
        this.outputListeners.clear();
        this.exitListeners.clear();
    }

    // --- internal (white-box tested) ---
    private appendScrollback(terminalId: string, data: string): void {
        const s = this.sessions.get(terminalId);
        if (!s) return;
        s.scrollback += data;
        if (s.scrollback.length > SCROLLBACK_BYTES) {
            s.scrollback = s.scrollback.slice(s.scrollback.length - SCROLLBACK_BYTES);
        }
    }

    private getScrollback(terminalId: string): string {
        return this.sessions.get(terminalId)?.scrollback ?? '';
    }
}
