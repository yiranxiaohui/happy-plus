import { describe, it, expect, vi, beforeEach } from 'vitest';

const { machineRPC, onTerminalOutput, onTerminalExit, terminalSendInput, terminalSendResize } = vi.hoisted(() => ({
    machineRPC: vi.fn(),
    onTerminalOutput: vi.fn((_handler: (e: any) => void) => () => {}),
    onTerminalExit: vi.fn((_handler: (e: any) => void) => () => {}),
    terminalSendInput: vi.fn(),
    terminalSendResize: vi.fn(),
}));

vi.mock('@/sync/apiSocket', () => ({
    apiSocket: { machineRPC, onTerminalOutput, onTerminalExit, terminalSendInput, terminalSendResize },
    getHappyClientId: () => 'test',
}));

// Mock RN-pulling imports so @/sync/ops imports cleanly in the node env
vi.mock('@/sync/sync', () => ({
    sync: {},
}));
vi.mock('@/sync/storageTypes', () => ({}));

import { TerminalController } from './useTerminal';

describe('TerminalController', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('creates a terminal then routes matching output to the sink', async () => {
        machineRPC.mockResolvedValueOnce({ terminalId: 't1' }); // terminal-create
        const writes: string[] = [];
        const ctrl = new TerminalController({ machineId: 'm1', cols: 80, rows: 24 }, { write: (d) => writes.push(d), reset: () => {} });

        await ctrl.start();
        expect(machineRPC).toHaveBeenCalledWith('m1', 'terminal-create', { cols: 80, rows: 24 });

        const handler = onTerminalOutput.mock.calls[0][0] as (e: any) => void;
        handler({ machineId: 'm1', terminalId: 't1', output: 'hi', seq: 1 });
        handler({ machineId: 'm1', terminalId: 'OTHER', output: 'nope', seq: 1 });
        expect(writes).toEqual(['hi']);
    });

    it('re-attaches and replays scrollback on a seq gap', async () => {
        machineRPC.mockResolvedValueOnce({ terminalId: 't1' });              // create
        machineRPC.mockResolvedValueOnce({ scrollback: 'REPLAYED', cols: 80, rows: 24, alive: true }); // attach
        const writes: string[] = [];
        let didReset = false;
        const ctrl = new TerminalController({ machineId: 'm1', cols: 80, rows: 24 }, { write: (d) => writes.push(d), reset: () => { didReset = true; } });
        await ctrl.start();
        const handler = onTerminalOutput.mock.calls[0][0] as (e: any) => void;
        handler({ machineId: 'm1', terminalId: 't1', output: 'a', seq: 1 });
        handler({ machineId: 'm1', terminalId: 't1', output: 'c', seq: 3 }); // gap: missed seq 2
        await vi.waitFor(() => expect(didReset).toBe(true));
        expect(machineRPC).toHaveBeenCalledWith('m1', 'terminal-attach', { terminalId: 't1' });
        expect(writes).toContain('REPLAYED');
    });
});
