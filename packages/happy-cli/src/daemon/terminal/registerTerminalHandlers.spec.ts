import { describe, it, expect, vi } from 'vitest';
import { registerTerminalHandlers } from './registerTerminalHandlers';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '@/api/encryption';

function makeFakeApiMachine() {
    const rpc = new Map<string, (p: any) => any>();
    const events = new Map<string, (d: any) => void>();
    const emitted: Array<{ event: string; data: any }> = [];
    const key = new Uint8Array(32).fill(7);
    return {
        machineId: 'm1',
        rpc, events, emitted, key,
        registerRpcHandler: (m: string, h: any) => rpc.set(m, h),
        onEvent: (e: string, h: any) => events.set(e, h),
        emitEvent: (e: string, d: any) => emitted.push({ event: e, data: d }),
        getEncryption: () => ({ key, variant: 'dataKey' as const }),
    };
}

describe('registerTerminalHandlers', () => {
    it('creates a terminal via RPC and streams encrypted output', async () => {
        const api = makeFakeApiMachine();
        registerTerminalHandlers(api as any, 'm1', { terminalEnabled: true });

        const created = await api.rpc.get('terminal-create')!({ cols: 80, rows: 24, shell: process.env.SHELL || '/bin/bash' });
        expect(typeof created.terminalId).toBe('string');

        const input = encodeBase64(encrypt(api.key, 'dataKey', { input: 'echo HELLO_T; exit\r' }));
        api.events.get('terminal-input')!({ machineId: 'm1', terminalId: created.terminalId, data: input });

        await vi.waitFor(() => {
            const out = api.emitted.filter(e => e.event === 'terminal-output');
            const joined = out.map(e => decrypt(api.key, 'dataKey', decodeBase64(e.data.data)).output).join('');
            expect(joined).toContain('HELLO_T');
        }, { timeout: 5000 });

        await vi.waitFor(() => {
            expect(api.emitted.some(e => e.event === 'terminal-exit')).toBe(true);
        }, { timeout: 5000 });
    });
});
