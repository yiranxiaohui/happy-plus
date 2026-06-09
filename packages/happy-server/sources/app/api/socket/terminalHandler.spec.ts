import { describe, it, expect, vi } from 'vitest';
import { terminalHandler } from './terminalHandler';

function makeSocket(clientType: string, machineId?: string) {
    const handlers: Record<string, (d: any) => void> = {};
    return {
        data: { clientType, machineId },
        on: (e: string, h: (d: any) => void) => { handlers[e] = h; },
        _fire: (e: string, d: any) => handlers[e]?.(d),
    };
}

describe('terminalHandler', () => {
    it('relays terminal-input from app to the machine room', () => {
        const emit = vi.fn();
        const io = { to: vi.fn(() => ({ emit })) } as any;
        const socket = makeSocket('user-scoped');
        terminalHandler('u1', socket as any, io);

        socket._fire('terminal-input', { machineId: 'm1', terminalId: 't1', data: 'enc' });

        expect(io.to).toHaveBeenCalledWith('user:u1:machine:m1');
        expect(emit).toHaveBeenCalledWith('terminal-input', { machineId: 'm1', terminalId: 't1', data: 'enc' });
    });

    it('relays terminal-output from a machine socket to user-scoped room', () => {
        const emit = vi.fn();
        const io = { to: vi.fn(() => ({ emit })) } as any;
        const socket = makeSocket('machine-scoped', 'm1');
        terminalHandler('u1', socket as any, io);

        socket._fire('terminal-output', { machineId: 'm1', terminalId: 't1', data: 'enc', seq: 5 });

        expect(io.to).toHaveBeenCalledWith('user:u1:user-scoped');
        expect(emit).toHaveBeenCalledWith('terminal-output', { machineId: 'm1', terminalId: 't1', data: 'enc', seq: 5 });
    });

    it('ignores terminal-output from a non-machine socket (anti-spoof)', () => {
        const emit = vi.fn();
        const io = { to: vi.fn(() => ({ emit })) } as any;
        const socket = makeSocket('user-scoped');
        terminalHandler('u1', socket as any, io);
        socket._fire('terminal-output', { machineId: 'm1', terminalId: 't1', data: 'enc', seq: 1 });
        expect(io.to).not.toHaveBeenCalled();
    });
});
