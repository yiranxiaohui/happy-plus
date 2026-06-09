import { describe, it, expect, vi } from 'vitest';

vi.mock('./apiSocket', () => ({
    apiSocket: { machineRPC: vi.fn() },
    getHappyClientId: () => 'test-client',
}));

// Mock sync to avoid pulling in react-native and expo modules
vi.mock('./sync', () => ({
    sync: {},
}));

// Mock storageTypes if needed
vi.mock('./storageTypes', () => ({}));

import { apiSocket } from './apiSocket';
import { terminalCreate, terminalAttach, terminalList, terminalClose } from './ops';

describe('terminal ops', () => {
    it('terminalCreate calls machineRPC with terminal-create', async () => {
        (apiSocket.machineRPC as any).mockResolvedValue({ terminalId: 't1' });
        const r = await terminalCreate({ machineId: 'm1', cols: 80, rows: 24, cwd: '/tmp' });
        expect(apiSocket.machineRPC).toHaveBeenCalledWith('m1', 'terminal-create', { cols: 80, rows: 24, cwd: '/tmp' });
        expect(r).toEqual({ terminalId: 't1' });
    });

    it('terminalList returns the terminals array', async () => {
        (apiSocket.machineRPC as any).mockResolvedValue({ terminals: [{ id: 't1' }] });
        const r = await terminalList('m1');
        expect(apiSocket.machineRPC).toHaveBeenCalledWith('m1', 'terminal-list', {});
        expect(r.terminals.length).toBe(1);
    });
});
