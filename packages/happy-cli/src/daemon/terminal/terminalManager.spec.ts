import { describe, it, expect, vi } from 'vitest';
import { TerminalManager } from './terminalManager';

// Use a fast, deterministic shell command for tests.
const SHELL = process.env.SHELL || '/bin/bash';

describe('TerminalManager', () => {
    it('creates a terminal and streams output, then exits on shell end', async () => {
        const mgr = new TerminalManager();
        const outputs: string[] = [];
        let exitCode: number | null = null;
        mgr.onOutput((id, data) => { outputs.push(data); });
        mgr.onExit((id, code) => { exitCode = code; });

        const { terminalId } = mgr.create({ cols: 80, rows: 24, shell: SHELL });
        expect(typeof terminalId).toBe('string');

        // Write a command that prints and exits.
        mgr.write(terminalId, 'echo HELLO_TERM; exit\r');

        // Wait for exit.
        await vi.waitFor(() => expect(exitCode).not.toBeNull(), { timeout: 5000 });
        expect(outputs.join('')).toContain('HELLO_TERM');
        mgr.shutdown();
    });

    it('caps the scrollback buffer at SCROLLBACK_BYTES', async () => {
        const mgr = new TerminalManager();
        const { terminalId } = mgr.create({ cols: 80, rows: 24, shell: SHELL });
        // Push more than the cap directly via the internal append (white-box).
        const big = 'x'.repeat(300 * 1024);
        (mgr as any).appendScrollback(terminalId, big);
        const buf = (mgr as any).getScrollback(terminalId) as string;
        expect(buf.length).toBeLessThanOrEqual(256 * 1024);
        // Keeps the most recent bytes.
        expect(buf.endsWith('x')).toBe(true);
        mgr.shutdown();
    });
});
