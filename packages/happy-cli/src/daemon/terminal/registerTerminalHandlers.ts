import { TerminalManager, TerminalCreateParams } from './terminalManager';
import { OutputCoalescer } from './outputCoalescer';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '@/api/encryption';

const OUTPUT_FLUSH_MS = 16;
const OUTPUT_MAX_CHUNK = 64 * 1024;

interface ApiMachineLike {
    registerRpcHandler: (method: string, handler: (params: any) => any) => void;
    onEvent: (event: string, handler: (data: any) => void) => void;
    emitEvent: (event: string, data: any) => void;
    getEncryption: () => { key: Uint8Array; variant: 'legacy' | 'dataKey' };
}

/**
 * Bridges TerminalManager to the machine socket:
 *  - RPC: terminal-create / terminal-attach / terminal-list / terminal-close (auto enc/dec)
 *  - events in:  terminal-input (encrypted), terminal-resize (plain)
 *  - events out: terminal-output (encrypted, coalesced), terminal-exit (plain)
 */
export function registerTerminalHandlers(api: ApiMachineLike, machineId: string, opts: { terminalEnabled: boolean }): TerminalManager {
    const mgr = new TerminalManager();
    const { key, variant } = api.getEncryption();
    const coalescers = new Map<string, OutputCoalescer>();
    const emitSeqByTerminal = new Map<string, number>();

    const coalescerFor = (terminalId: string) => {
        let c = coalescers.get(terminalId);
        if (!c) {
            c = new OutputCoalescer((data) => {
                const seq = (emitSeqByTerminal.get(terminalId) ?? 0) + 1;
                emitSeqByTerminal.set(terminalId, seq);
                const enc = encodeBase64(encrypt(key, variant, { output: data }));
                api.emitEvent('terminal-output', { machineId, terminalId, data: enc, seq });
            }, { flushMs: OUTPUT_FLUSH_MS, maxChunk: OUTPUT_MAX_CHUNK });
            coalescers.set(terminalId, c);
        }
        return c;
    };

    mgr.onOutput((terminalId, data) => { coalescerFor(terminalId).push(data); });
    mgr.onExit((terminalId, exitCode) => {
        coalescers.get(terminalId)?.flushNow();
        coalescers.get(terminalId)?.dispose();
        coalescers.delete(terminalId);
        emitSeqByTerminal.delete(terminalId);
        api.emitEvent('terminal-exit', { machineId, terminalId, exitCode });
    });

    api.registerRpcHandler('terminal-create', (params: TerminalCreateParams) => {
        if (!opts.terminalEnabled) {
            throw new Error('Terminal is disabled on this machine');
        }
        return mgr.create(params);
    });
    api.registerRpcHandler('terminal-attach', (params: { terminalId: string }) => {
        const r = mgr.attach(params.terminalId);
        return r ?? { scrollback: '', cols: 80, rows: 24, alive: false };
    });
    api.registerRpcHandler('terminal-list', () => mgr.list());
    api.registerRpcHandler('terminal-close', (params: { terminalId: string }) => mgr.close(params.terminalId));

    api.onEvent('terminal-input', (data: { machineId: string; terminalId: string; data: string }) => {
        if (data.machineId !== machineId) return;
        try {
            const { input } = decrypt(key, variant, decodeBase64(data.data)) as { input: string };
            mgr.write(data.terminalId, input);
        } catch { /* ignore malformed */ }
    });
    api.onEvent('terminal-resize', (data: { machineId: string; terminalId: string; cols: number; rows: number }) => {
        if (data.machineId !== machineId) return;
        mgr.resize(data.terminalId, data.cols, data.rows);
    });

    return mgr;
}
