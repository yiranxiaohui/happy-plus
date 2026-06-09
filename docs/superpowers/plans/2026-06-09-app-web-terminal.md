# Interactive Terminal (app & web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full interactive PTY terminal to the Happy app (iOS/Android) and web, letting a user open a shell on a registered machine (and from a session, in that session's cwd), with tmux-like persistence + reconnect.

**Architecture:** The CLI daemon hosts real PTYs via `node-pty` and keeps a scrollback ring buffer per terminal. Lifecycle (create/attach/list/close) flows over the existing RPC channel (auto-encrypted). High-frequency I/O (keystrokes, output, resize) flows over new custom socket events relayed by the server between the user's app connections and the machine daemon. Clients render with `xterm.js` — directly on web, inside `react-native-webview` on native. All terminal payloads are E2E-encrypted with the existing machine key; the server only relays ciphertext.

**Tech Stack:** node-pty (CLI), socket.io (existing transport), xterm.js + addons (clients), react-native-webview (native), Fastify/socket.io (server relay), Vitest (tests), pnpm monorepo.

**Spec:** `docs/superpowers/specs/2026-06-09-app-web-terminal-design.md`

---

## Naming & constants (locked — keep consistent across all tasks)

- CLI manager class: `TerminalManager` in `packages/happy-cli/src/daemon/terminal/terminalManager.ts`.
- RPC method names (registered with `${machineId}:` prefix by the manager infra): `terminal-create`, `terminal-attach`, `terminal-list`, `terminal-close`.
- Custom streaming events (bypass RPC): app→daemon `terminal-input`, `terminal-resize`; daemon→app `terminal-output`, `terminal-exit`.
- Scrollback cap: `SCROLLBACK_BYTES = 256 * 1024`.
- Concurrent terminals per machine cap: `MAX_TERMINALS = 20`.
- Output coalescing window: `OUTPUT_FLUSH_MS = 16`, `OUTPUT_MAX_CHUNK = 64 * 1024`.
- App route: `(app)/shell/[machineId].tsx` (NOT `terminal/...`, which is the CLI-pairing flow).
- Payload shapes (shared mental model):
  - `terminal-input`  `{ machineId, terminalId, data }` where `data` = base64(encrypt({ input: string }))
  - `terminal-resize` `{ machineId, terminalId, cols, rows }` (not encrypted — no secret content)
  - `terminal-output` `{ machineId, terminalId, data, seq }` where `data` = base64(encrypt({ output: string }))
  - `terminal-exit`   `{ machineId, terminalId, exitCode }`

---

## Phase 1 — CLI daemon: PTY terminal manager

### Task 1.1: Add node-pty dependency

**Files:**
- Modify: `packages/happy-cli/package.json` (dependencies)

- [ ] **Step 1: Add the dependency**

Use the multi-arch prebuilt fork to avoid node-gyp at user install time (see spec §3.5). In `packages/happy-cli/package.json` add to `"dependencies"`:

```json
"@homebridge/node-pty-prebuilt-multiarch": "^0.13.1"
```

> Implementation note: bumped to `^0.13.1` (from `^0.12.0`) — 0.12.0's newest prebuilt is ABI 131 (Node 22); the host runs Node 24 (ABI 137). 0.13.1 ships abi137 + abi115/120/131, so CI on Node 20/22 still resolves a prebuilt.

- [ ] **Step 2: Install**

Run: `cd /opt/happy-plus && pnpm install --filter happy-cli`
Expected: completes; a prebuilt binary is fetched (no compiler error). If it falls back to source build and fails, STOP and report — packaging risk per spec §7.

- [ ] **Step 3: Verify it loads**

Run: `cd /opt/happy-plus/packages/happy-cli && node -e "const pty=require('@homebridge/node-pty-prebuilt-multiarch'); const p=pty.spawn(process.env.SHELL||'bash',[], {cols:80,rows:24}); p.onData(d=>{process.stdout.write(d); p.kill()}); p.write('echo ok\r');"`
Expected: prints a shell prompt and `ok` then exits. Confirms the native module works on this platform.

- [ ] **Step 4: Commit**

```bash
git add packages/happy-cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): add node-pty (prebuilt-multiarch) dependency"
```

---

### Task 1.2: TerminalManager — create/write/output/scrollback

**Files:**
- Create: `packages/happy-cli/src/daemon/terminal/terminalManager.ts`
- Test: `packages/happy-cli/src/daemon/terminal/terminalManager.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/daemon/terminal/terminalManager.spec.ts`
Expected: FAIL — cannot find module `./terminalManager`.

- [ ] **Step 3: Write minimal implementation**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/daemon/terminal/terminalManager.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/daemon/terminal/terminalManager.ts packages/happy-cli/src/daemon/terminal/terminalManager.spec.ts
git commit -m "feat(cli): TerminalManager with PTY lifecycle + capped scrollback"
```

---

### Task 1.3: Output coalescing helper

**Files:**
- Create: `packages/happy-cli/src/daemon/terminal/outputCoalescer.ts`
- Test: `packages/happy-cli/src/daemon/terminal/outputCoalescer.spec.ts`

Rationale (spec §5.1 flow control): batch PTY output within `OUTPUT_FLUSH_MS` and cap chunk size before encrypting/emitting, so heavy output (`yes`, `cat bigfile`) doesn't flood the socket.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { OutputCoalescer } from './outputCoalescer';

describe('OutputCoalescer', () => {
    it('batches writes within the flush window into one flush', async () => {
        vi.useFakeTimers();
        const flushes: string[] = [];
        const c = new OutputCoalescer((data) => flushes.push(data), { flushMs: 16, maxChunk: 1024 });
        c.push('a'); c.push('b'); c.push('c');
        expect(flushes).toEqual([]);          // nothing yet
        vi.advanceTimersByTime(16);
        expect(flushes).toEqual(['abc']);     // one coalesced flush
        vi.useRealTimers();
    });

    it('flushes immediately when exceeding maxChunk', () => {
        const flushes: string[] = [];
        const c = new OutputCoalescer((data) => flushes.push(data), { flushMs: 1000, maxChunk: 4 });
        c.push('12345');                      // > maxChunk → immediate flush
        expect(flushes.length).toBe(1);
        expect(flushes[0]).toBe('12345');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/daemon/terminal/outputCoalescer.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```typescript
export interface CoalescerOptions { flushMs: number; maxChunk: number; }

/** Buffers strings and flushes them coalesced on a timer, or immediately when
 *  the buffer exceeds maxChunk. One instance per terminal. */
export class OutputCoalescer {
    private buf = '';
    private timer: ReturnType<typeof setTimeout> | null = null;
    constructor(private readonly flush: (data: string) => void, private readonly opts: CoalescerOptions) {}

    push(data: string): void {
        this.buf += data;
        if (this.buf.length >= this.opts.maxChunk) {
            this.flushNow();
            return;
        }
        if (!this.timer) {
            this.timer = setTimeout(() => this.flushNow(), this.opts.flushMs);
        }
    }

    flushNow(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.buf.length === 0) return;
        const data = this.buf;
        this.buf = '';
        this.flush(data);
    }

    dispose(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this.buf = '';
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/daemon/terminal/outputCoalescer.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/daemon/terminal/outputCoalescer.ts packages/happy-cli/src/daemon/terminal/outputCoalescer.spec.ts
git commit -m "feat(cli): output coalescer for terminal streaming backpressure"
```

---

### Task 1.4: apiMachine plumbing — register RPC handlers + emit/listen custom events

The daemon's machine socket lives in `apiMachine` (`packages/happy-cli/src/api/apiMachine.ts`). It already exposes `setRPCHandlers(...)`. Add passthroughs so terminal code can (a) register extra RPC handlers and (b) emit/subscribe arbitrary socket events that survive reconnects.

**Files:**
- Modify: `packages/happy-cli/src/api/apiMachine.ts`

- [ ] **Step 1: Add an event-binding registry field**

Near the other private fields in the `ApiMachineClient` class add:

```typescript
    // Arbitrary (non-RPC) socket event listeners that must be (re)bound on every connect.
    private customEventListeners = new Map<string, (data: any) => void>();
```

- [ ] **Step 2: Expose registerRpcHandler + emitEvent + onEvent + machine encryption accessors**

Add these public methods to `ApiMachineClient` (place after `setRPCHandlers`):

```typescript
    /** Register an extra RPC method on this machine's scope (auto encrypt/decrypt). */
    registerRpcHandler<TReq = any, TResp = any>(method: string, handler: (params: TReq) => Promise<TResp> | TResp): void {
        this.rpcHandlerManager.registerHandler<TReq, TResp>(method, handler as any);
    }

    /** Emit an arbitrary event to the server over the machine socket (fire-and-forget). */
    emitEvent(event: string, data: any): void {
        this.socket?.emit(event as any, data);
    }

    /** Subscribe to an arbitrary server→daemon event. Rebound automatically on reconnect. */
    onEvent(event: string, handler: (data: any) => void): void {
        this.customEventListeners.set(event, handler);
        this.socket?.on(event as any, handler as any);
    }

    /** The machine's E2E key material, for encrypting/decrypting streaming payloads. */
    getEncryption(): { key: Uint8Array; variant: 'legacy' | 'dataKey' } {
        return { key: this.machine.encryptionKey, variant: this.machine.encryptionVariant };
    }
```

- [ ] **Step 3: Rebind custom listeners inside connect()**

In `connect()`, immediately after the socket is created and the existing `this.socket.on(...)` handlers are attached, add:

```typescript
        // Re-attach any custom (terminal) event listeners after (re)connect.
        for (const [event, handler] of this.customEventListeners) {
            this.socket.on(event as any, handler as any);
        }
```

- [ ] **Step 4: Typecheck**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec tsc --noEmit`
Expected: PASS (no new errors). If `socket.emit/on` typing rejects custom event names, the `as any` casts above cover it.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/api/apiMachine.ts
git commit -m "feat(cli): apiMachine passthroughs for terminal RPC + custom events"
```

---

### Task 1.5: Wire terminal handlers into the daemon

Bridge `TerminalManager` to the machine socket: register the 4 RPC methods, relay input/resize in, and stream output/exit out (encrypted, coalesced).

**Files:**
- Create: `packages/happy-cli/src/daemon/terminal/registerTerminalHandlers.ts`
- Test: `packages/happy-cli/src/daemon/terminal/registerTerminalHandlers.spec.ts`
- Modify: `packages/happy-cli/src/daemon/run.ts` (call the new wiring after `apiMachine.connect()`)

- [ ] **Step 1: Write the failing test**

```typescript
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
        registerTerminalHandlers(api as any, 'm1');

        const created = await api.rpc.get('terminal-create')!({ cols: 80, rows: 24, shell: process.env.SHELL || '/bin/bash' });
        expect(typeof created.terminalId).toBe('string');

        // Send input via the inbound event handler (decrypts internally).
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/daemon/terminal/registerTerminalHandlers.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```typescript
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
export function registerTerminalHandlers(api: ApiMachineLike, machineId: string): TerminalManager {
    const mgr = new TerminalManager();
    const { key, variant } = api.getEncryption();
    const coalescers = new Map<string, OutputCoalescer>();

    const coalescerFor = (terminalId: string) => {
        let c = coalescers.get(terminalId);
        if (!c) {
            c = new OutputCoalescer((data) => {
                const enc = encodeBase64(encrypt(key, variant, { output: data }));
                api.emitEvent('terminal-output', { machineId, terminalId, data: enc, seq: 0 });
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
        api.emitEvent('terminal-exit', { machineId, terminalId, exitCode });
    });

    api.registerRpcHandler('terminal-create', (params: TerminalCreateParams) => mgr.create(params));
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/daemon/terminal/registerTerminalHandlers.spec.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the daemon**

In `packages/happy-cli/src/daemon/run.ts`, add the import at the top:

```typescript
import { registerTerminalHandlers } from './terminal/registerTerminalHandlers';
```

Immediately after `apiMachine.connect();` (around line 834), add:

```typescript
    // Interactive terminal (PTY) handlers — RPC lifecycle + streaming events.
    const terminalManager = registerTerminalHandlers(apiMachine as any, machine.id);
    onShutdownCleanup?.(() => terminalManager.shutdown());
```

If there is no existing shutdown-cleanup hook variable named `onShutdownCleanup` in scope, instead register via the same mechanism used to clean up other daemon resources in this file (search for existing `requestShutdown`/cleanup wiring) and call `terminalManager.shutdown()` there. The goal: PTYs are killed on daemon shutdown.

- [ ] **Step 6: Typecheck + full CLI test run**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec tsc --noEmit && pnpm exec vitest run --project unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/happy-cli/src/daemon/terminal/registerTerminalHandlers.ts packages/happy-cli/src/daemon/terminal/registerTerminalHandlers.spec.ts packages/happy-cli/src/daemon/run.ts
git commit -m "feat(cli): wire terminal RPC + streaming handlers into daemon"
```

---

## Phase 2 — Server: terminal event relay

The server relays the 4 streaming events. Lifecycle RPC needs **no** server change (transparent). Because rooms are namespaced by the server-trusted `userId`, a user can only reach their own machine rooms — ownership is enforced by routing.

### Task 2.1: terminalHandler relay

**Files:**
- Create: `packages/happy-server/sources/app/api/socket/terminalHandler.ts`
- Test: `packages/happy-server/sources/app/api/socket/terminalHandler.spec.ts`
- Modify: `packages/happy-server/sources/app/api/socket.ts` (register the handler)

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/happy-plus/packages/happy-server && pnpm exec vitest run sources/app/api/socket/terminalHandler.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```typescript
import { Server, Socket } from 'socket.io';

/**
 * Relays interactive-terminal streaming events between a user's app
 * connections and their machine daemons. Rooms are namespaced by the
 * server-trusted userId, so a user can only target their own machine
 * (ownership enforced by routing). The server relays ciphertext only.
 */
export function terminalHandler(userId: string, socket: Socket, io: Server) {
    const machineRoom = (machineId: string) => `user:${userId}:machine:${machineId}`;
    const userScopedRoom = `user:${userId}:user-scoped`;

    // app → daemon
    socket.on('terminal-input', (data: { machineId: string; terminalId: string; data: string }) => {
        if (!data?.machineId || !data?.terminalId) return;
        io.to(machineRoom(data.machineId)).emit('terminal-input', data);
    });
    socket.on('terminal-resize', (data: { machineId: string; terminalId: string; cols: number; rows: number }) => {
        if (!data?.machineId || !data?.terminalId) return;
        io.to(machineRoom(data.machineId)).emit('terminal-resize', data);
    });

    // daemon → app (only honor these from an actual machine socket)
    const isMachine = socket.data.clientType === 'machine-scoped';
    socket.on('terminal-output', (data: { machineId: string; terminalId: string; data: string; seq: number }) => {
        if (!isMachine || socket.data.machineId !== data?.machineId) return;
        io.to(userScopedRoom).emit('terminal-output', data);
    });
    socket.on('terminal-exit', (data: { machineId: string; terminalId: string; exitCode: number }) => {
        if (!isMachine || socket.data.machineId !== data?.machineId) return;
        io.to(userScopedRoom).emit('terminal-exit', data);
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/happy-plus/packages/happy-server && pnpm exec vitest run sources/app/api/socket/terminalHandler.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register in socket.ts**

In `packages/happy-server/sources/app/api/socket.ts`, add the import near the other socket-handler imports:

```typescript
import { terminalHandler } from './socket/terminalHandler';
```

In the connection callback, alongside the other handler calls (`rpcHandler(userId, socket, io);` etc., ~line 207-214), add:

```typescript
    terminalHandler(userId, socket, io);
```

- [ ] **Step 6: Typecheck + full server test run**

Run: `cd /opt/happy-plus/packages/happy-server && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/happy-server/sources/app/api/socket/terminalHandler.ts packages/happy-server/sources/app/api/socket/terminalHandler.spec.ts packages/happy-server/sources/app/api/socket.ts
git commit -m "feat(server): terminal streaming event relay"
```

---

## Phase 3 — App: data layer

### Task 3.1: apiSocket terminal methods (encrypt/emit/listen)

Streaming events bypass RPC, so encryption must happen where the machine key lives (`apiSocket`'s `encryption`). Add four methods mirroring the existing `machineRPC` encryption usage.

**Files:**
- Modify: `packages/happy-app/sources/sync/apiSocket.ts`

- [ ] **Step 1: Add the methods**

Place these inside the apiSocket class, near `machineRPC` (~line 166):

```typescript
    /** Send a keystroke/input chunk to a machine terminal (E2E encrypted). */
    async terminalSendInput(machineId: string, terminalId: string, input: string): Promise<void> {
        const enc = this.encryption!.getMachineEncryption(machineId);
        if (!enc) throw new Error(`Machine encryption not found for ${machineId}`);
        const data = await enc.encryptRaw({ input });
        this.socket!.emit('terminal-input', { machineId, terminalId, data });
    }

    /** Notify a machine terminal of a viewport resize (no secret content). */
    terminalSendResize(machineId: string, terminalId: string, cols: number, rows: number): void {
        this.socket!.emit('terminal-resize', { machineId, terminalId, cols, rows });
    }

    /** Subscribe to decrypted terminal output. Returns an unsubscribe fn. */
    onTerminalOutput(handler: (e: { machineId: string; terminalId: string; output: string; seq: number }) => void): () => void {
        return this.onMessage('terminal-output', async (raw: { machineId: string; terminalId: string; data: string; seq: number }) => {
            const enc = this.encryption!.getMachineEncryption(raw.machineId);
            if (!enc) return;
            const payload = await enc.decryptRaw(raw.data) as { output: string } | null;
            if (!payload) return;
            handler({ machineId: raw.machineId, terminalId: raw.terminalId, output: payload.output, seq: raw.seq });
        });
    }

    /** Subscribe to terminal exit notifications. Returns an unsubscribe fn. */
    onTerminalExit(handler: (e: { machineId: string; terminalId: string; exitCode: number }) => void): () => void {
        return this.onMessage('terminal-exit', (raw: { machineId: string; terminalId: string; exitCode: number }) => handler(raw));
    }
```

> Note: `onMessage` (see apiSocket.ts:134) stores a single handler per event in a Map and routes via `onAny`. If multiple `<Terminal>` instances must listen simultaneously, Task 3.3's hook funnels all of them through ONE subscription created once (see hook design) — do not call `onTerminalOutput` per-component.

- [ ] **Step 2: Typecheck**

Run: `cd /opt/happy-plus/packages/happy-app && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/happy-app/sources/sync/apiSocket.ts
git commit -m "feat(app): apiSocket terminal input/output/resize methods"
```

---

### Task 3.2: ops terminal lifecycle functions

**Files:**
- Modify: `packages/happy-app/sources/sync/ops.ts`
- Test: `packages/happy-app/sources/sync/opsTerminal.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('./apiSocket', () => ({
    apiSocket: { machineRPC: vi.fn() },
    getHappyClientId: () => 'test-client',
}));

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/happy-plus/packages/happy-app && pnpm exec vitest run sources/sync/opsTerminal.spec.ts`
Expected: FAIL — `terminalCreate` is not exported.

- [ ] **Step 3: Add the functions to ops.ts**

Append to `packages/happy-app/sources/sync/ops.ts`:

```typescript
export interface TerminalInfo { id: string; title: string; cwd: string; rows: number; cols: number; createdAt: number; }

export async function terminalCreate(opts: { machineId: string; cols: number; rows: number; cwd?: string; shell?: string }): Promise<{ terminalId: string }> {
    const { machineId, cols, rows, cwd, shell } = opts;
    return apiSocket.machineRPC<{ terminalId: string }, { cols: number; rows: number; cwd?: string; shell?: string }>(
        machineId, 'terminal-create', { cols, rows, cwd, shell },
    );
}

export async function terminalAttach(machineId: string, terminalId: string): Promise<{ scrollback: string; cols: number; rows: number; alive: boolean }> {
    return apiSocket.machineRPC(machineId, 'terminal-attach', { terminalId });
}

export async function terminalList(machineId: string): Promise<{ terminals: TerminalInfo[] }> {
    return apiSocket.machineRPC<{ terminals: TerminalInfo[] }, {}>(machineId, 'terminal-list', {});
}

export async function terminalClose(machineId: string, terminalId: string): Promise<{ ok: boolean }> {
    return apiSocket.machineRPC(machineId, 'terminal-close', { terminalId });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/happy-plus/packages/happy-app && pnpm exec vitest run sources/sync/opsTerminal.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-app/sources/sync/ops.ts packages/happy-app/sources/sync/opsTerminal.spec.ts
git commit -m "feat(app): terminal lifecycle ops (create/attach/list/close)"
```

---

### Task 3.3: useTerminal hook

Glue: create-or-attach on mount, feed output into a sink (xterm write), pump input out, resize, detect `seq` gaps → re-attach + replay scrollback, handle reconnect.

**Files:**
- Create: `packages/happy-app/sources/hooks/useTerminal.ts`
- Test: `packages/happy-app/sources/hooks/useTerminal.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const machineRPC = vi.fn();
const onTerminalOutput = vi.fn(() => () => {});
const onTerminalExit = vi.fn(() => () => {});
const terminalSendInput = vi.fn();
const terminalSendResize = vi.fn();

vi.mock('@/sync/apiSocket', () => ({
    apiSocket: { machineRPC, onTerminalOutput, onTerminalExit, terminalSendInput, terminalSendResize },
    getHappyClientId: () => 'test',
}));

import { TerminalController } from './useTerminal';

describe('TerminalController', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('creates a terminal then routes matching output to the sink', async () => {
        machineRPC.mockResolvedValueOnce({ terminalId: 't1' }); // terminal-create
        const writes: string[] = [];
        const ctrl = new TerminalController({ machineId: 'm1', cols: 80, rows: 24 }, { write: (d) => writes.push(d), reset: () => {} });

        await ctrl.start();
        expect(machineRPC).toHaveBeenCalledWith('m1', 'terminal-create', { cols: 80, rows: 24, cwd: undefined, shell: undefined });

        // Simulate an output event for our terminal and a foreign one.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/happy-plus/packages/happy-app && pnpm exec vitest run sources/hooks/useTerminal.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```typescript
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
                // Gap detected — re-attach and replay.
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
            this.lastSeq = 0; // resync; subsequent seqs resume monotonic from server
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/happy-plus/packages/happy-app && pnpm exec vitest run sources/hooks/useTerminal.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/happy-app/sources/hooks/useTerminal.ts packages/happy-app/sources/hooks/useTerminal.spec.ts
git commit -m "feat(app): useTerminal hook + TerminalController (reconnect/replay)"
```

---

## Phase 4 — App: UI

### Task 4.1: Add xterm dependency + build the webview asset

**Files:**
- Modify: `packages/happy-app/package.json` (dependencies + a build script)
- Create: `packages/happy-app/scripts/build-terminal-asset.mjs`
- Create (generated): `packages/happy-app/assets/terminal/index.html`

- [ ] **Step 1: Add dependencies**

In `packages/happy-app/package.json` `"dependencies"` add:

```json
"@xterm/xterm": "^5.5.0",
"@xterm/addon-fit": "^0.10.0"
```

(react-native-webview 13.15.0 is already present.)

- [ ] **Step 2: Install**

Run: `cd /opt/happy-plus && pnpm install --filter happy-app`
Expected: completes.

- [ ] **Step 3: Write the asset build script**

`packages/happy-app/scripts/build-terminal-asset.mjs`:

```javascript
// Builds a self-contained HTML file that hosts xterm.js for the native webview.
// Inlines xterm's UMD JS + CSS so the webview needs no network. Run via
// `pnpm build:terminal-asset` and commit the output (assets/terminal/index.html).
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const req = (p) => readFileSync(resolve(pkgRoot, 'node_modules', p), 'utf8');

const xtermJs = req('@xterm/xterm/lib/xterm.js');
const xtermCss = req('@xterm/xterm/css/xterm.css');
const fitJs = req('@xterm/addon-fit/lib/addon-fit.js');

const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>${xtermCss}
html,body{margin:0;padding:0;height:100%;background:#000}#t{height:100%;width:100%}</style>
</head><body><div id="t"></div>
<script>${xtermJs}</script>
<script>${fitJs}</script>
<script>
(function(){
  var term = new Terminal({ convertEol:false, cursorBlink:true, fontFamily:'monospace', fontSize:13, theme:{background:'#000000'} });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('t'));
  fit.fit();
  function post(msg){ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
  term.onData(function(d){ post({type:'input',data:d}); });
  function sendResize(){ try{ fit.fit(); }catch(e){} post({type:'resize',cols:term.cols,rows:term.rows}); }
  window.addEventListener('resize', sendResize);
  // RN → webview bridge.
  function onHostMessage(ev){
    try{
      var m = JSON.parse(ev.data);
      if(m.type==='write') term.write(m.data);
      else if(m.type==='clear') term.reset();
      else if(m.type==='fit') sendResize();
      else if(m.type==='focus') term.focus();
    }catch(e){}
  }
  document.addEventListener('message', onHostMessage); // Android
  window.addEventListener('message', onHostMessage);   // iOS
  setTimeout(sendResize, 50);
})();
</script></body></html>`;

mkdirSync(resolve(pkgRoot, 'assets/terminal'), { recursive: true });
writeFileSync(resolve(pkgRoot, 'assets/terminal/index.html'), html);
console.log('Wrote assets/terminal/index.html (' + html.length + ' bytes)');
```

- [ ] **Step 4: Add the build script to package.json**

In `packages/happy-app/package.json` `"scripts"` add:

```json
"build:terminal-asset": "node scripts/build-terminal-asset.mjs"
```

- [ ] **Step 5: Generate the asset**

Run: `cd /opt/happy-plus/packages/happy-app && pnpm build:terminal-asset`
Expected: prints "Wrote assets/terminal/index.html (...)". File exists and is non-trivial in size (>200KB).

- [ ] **Step 6: Commit**

```bash
git add packages/happy-app/package.json packages/happy-app/scripts/build-terminal-asset.mjs packages/happy-app/assets/terminal/index.html pnpm-lock.yaml
git commit -m "feat(app): add xterm.js + generated webview terminal asset"
```

---

### Task 4.2: `<TerminalView>` component (web direct, native webview)

**Files:**
- Create: `packages/happy-app/sources/components/terminal/TerminalView.tsx`
- Create: `packages/happy-app/sources/components/terminal/TerminalView.web.tsx`

Expo/Metro resolves `.web.tsx` for web automatically, so the platform split needs no runtime `Platform.OS` branching for this component.

- [ ] **Step 1: Native implementation (webview)**

`packages/happy-app/sources/components/terminal/TerminalView.tsx`:

```typescript
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
```

- [ ] **Step 2: Web implementation (xterm directly)**

`packages/happy-app/sources/components/terminal/TerminalView.web.tsx`:

```typescript
import * as React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TerminalViewHandle, TerminalViewProps } from './TerminalView';

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
```

> `TerminalViewProps`/`TerminalViewHandle` are imported by the web file from the native file purely as types — type-only imports are erased, so Metro won't pull react-native-webview into the web bundle.

- [ ] **Step 3: Typecheck**

Run: `cd /opt/happy-plus/packages/happy-app && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/happy-app/sources/components/terminal/TerminalView.tsx packages/happy-app/sources/components/terminal/TerminalView.web.tsx
git commit -m "feat(app): TerminalView component (web xterm / native webview)"
```

---

### Task 4.3: Accessory key bar (mobile special keys)

**Files:**
- Create: `packages/happy-app/sources/components/terminal/TerminalKeyBar.tsx`

- [ ] **Step 1: Implement**

```typescript
import * as React from 'react';
import { View, Pressable, Text, ScrollView, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

// Maps a label to the raw bytes written to the PTY.
const KEYS: Array<{ label: string; seq: string }> = [
    { label: 'esc', seq: '\x1b' },
    { label: 'tab', seq: '\t' },
    { label: 'ctrl-c', seq: '\x03' },
    { label: 'ctrl-d', seq: '\x04' },
    { label: 'ctrl-z', seq: '\x1a' },
    { label: 'ctrl-l', seq: '\x0c' },
    { label: '↑', seq: '\x1b[A' },
    { label: '↓', seq: '\x1b[B' },
    { label: '←', seq: '\x1b[D' },
    { label: '→', seq: '\x1b[C' },
    { label: '|', seq: '|' },
    { label: '/', seq: '/' },
    { label: '~', seq: '~' },
];

export const TerminalKeyBar = React.memo(({ onKey }: { onKey: (seq: string) => void }) => {
    // Only useful where the soft keyboard lacks these keys.
    if (Platform.OS === 'web') return null;
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={styles.bar}>
            {KEYS.map((k) => (
                <Pressable key={k.label} onPress={() => onKey(k.seq)} style={styles.key}>
                    <Text style={styles.keyText}>{k.label}</Text>
                </Pressable>
            ))}
        </ScrollView>
    );
});

const styles = StyleSheet.create((theme) => ({
    bar: { flexGrow: 0, backgroundColor: theme.colors.surfaceHigh, paddingVertical: 6, paddingHorizontal: 6 },
    key: { paddingHorizontal: 12, paddingVertical: 8, marginHorizontal: 3, borderRadius: 6, backgroundColor: theme.colors.groupped.background },
    keyText: { color: theme.colors.text, fontSize: 13, fontFamily: 'monospace' },
}));
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd /opt/happy-plus/packages/happy-app && pnpm exec tsc --noEmit`
Expected: PASS.

```bash
git add packages/happy-app/sources/components/terminal/TerminalKeyBar.tsx
git commit -m "feat(app): terminal accessory key bar for mobile"
```

---

### Task 4.4: Shell screen `(app)/shell/[machineId].tsx` + route registration

**Files:**
- Create: `packages/happy-app/sources/app/(app)/shell/[machineId].tsx`
- Modify: `packages/happy-app/sources/app/(app)/_layout.tsx` (register the screen)
- Modify: i18n (see Task 5.2 for strings; use `t('terminal.title')` here)

- [ ] **Step 1: Implement the screen**

```typescript
import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useTerminal, TerminalSink } from '@/hooks/useTerminal';
import { TerminalView, TerminalViewHandle } from '@/components/terminal/TerminalView';
import { TerminalKeyBar } from '@/components/terminal/TerminalKeyBar';
import { t } from '@/text';

export default React.memo(() => {
    const params = useLocalSearchParams<{ machineId: string; cwd?: string; terminalId?: string }>();
    const machineId = params.machineId!;
    const handleRef = React.useRef<TerminalViewHandle | null>(null);
    const [cols, setCols] = React.useState(80);
    const [rows, setRows] = React.useState(24);

    const sink = React.useMemo<TerminalSink>(() => ({
        write: (d) => handleRef.current?.sink.write(d),
        reset: () => handleRef.current?.sink.reset(),
    }), []);

    const term = useTerminal(
        { machineId, cols, rows, cwd: params.cwd, terminalId: params.terminalId },
        sink,
    );

    return (
        <View style={{ flex: 1, backgroundColor: '#000' }}>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('terminal.title') }} />
            <TerminalView
                onReady={(h) => { handleRef.current = h; h.focus(); }}
                onInput={(d) => term.write(d)}
                onResize={(c, r) => { setCols(c); setRows(r); term.resize(c, r); }}
            />
            <TerminalKeyBar onKey={(seq) => term.write(seq)} />
        </View>
    );
});
```

- [ ] **Step 2: Register the route**

In `packages/happy-app/sources/app/(app)/_layout.tsx`, alongside the other `<Stack.Screen>` entries, add:

```typescript
<Stack.Screen
    name="shell/[machineId]"
    options={{ headerTitle: t('terminal.title') }}
/>
```

- [ ] **Step 3: Typecheck**

Run: `cd /opt/happy-plus/packages/happy-app && pnpm exec tsc --noEmit`
Expected: PASS (after Task 5.2 adds `terminal.title`; if running this first, temporarily use the literal string `'Terminal'` then switch to `t('terminal.title')`).

- [ ] **Step 4: Commit**

```bash
git add packages/happy-app/sources/app/(app)/shell/[machineId].tsx packages/happy-app/sources/app/(app)/_layout.tsx
git commit -m "feat(app): shell/[machineId] interactive terminal screen"
```

---

### Task 4.5: Entry points — machine screen + session screen buttons

**Files:**
- Modify: `packages/happy-app/sources/app/(app)/machine/[id].tsx` (add "Open Terminal")
- Modify: the session screen header/actions (the session screen is `SessionView`; add a terminal action that navigates with the session's machineId + cwd)

- [ ] **Step 1: Machine screen button**

In `packages/happy-app/sources/app/(app)/machine/[id].tsx`, near the "launch new session" group (~line 381), add an item that navigates to the shell screen:

```typescript
<ItemGroup title={t('terminal.title')}>
    <Item
        title={t('terminal.open')}
        icon={<Ionicons name="terminal-outline" size={24} color={theme.colors.text} />}
        disabled={!isMachineOnline(machine)}
        onPress={() => router.push(`/shell/${machineId}`)}
    />
</ItemGroup>
```

(Use the file's existing `Item`/`ItemGroup` imports and `router` from `useRouter()`; both are already present in this screen.)

- [ ] **Step 2: Session screen action**

In the session screen (find where session header actions are rendered in `packages/happy-app/sources/-session/SessionView.tsx`), add a terminal button that resolves the session's `machineId` and working directory from the session object and navigates:

```typescript
// where `session` is in scope, and metadata holds machineId + path:
onPress={() => {
    if (session?.metadata?.machineId) {
        const cwd = session.metadata.path ? `&cwd=${encodeURIComponent(session.metadata.path)}` : '';
        router.push(`/shell/${session.metadata.machineId}?from=session${cwd}`);
    }
}}
```

Place the button consistent with existing session header actions. If the session metadata field names differ, match the names used elsewhere in `SessionView` to read machineId/path (search the file for `metadata.path` / `machineId`).

- [ ] **Step 3: Typecheck**

Run: `cd /opt/happy-plus/packages/happy-app && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/happy-app/sources/app/(app)/machine/[id].tsx packages/happy-app/sources/-session/SessionView.tsx
git commit -m "feat(app): terminal entry points on machine + session screens"
```

---

## Phase 5 — Settings toggle, i18n, packaging, CI

### Task 5.1: "Allow terminal" setting (per spec §5.2)

Default ON. A daemon-side guard so a security-conscious user can disable terminals on a machine.

**Files:**
- Modify: `packages/happy-cli/src/daemon/terminal/registerTerminalHandlers.ts` (guard in `terminal-create`)
- Modify: wherever CLI daemon settings/config are read (search for the existing settings module, e.g. `persistence.ts` / a settings schema) to add `terminalEnabled: boolean` default `true`.

- [ ] **Step 1: Add the setting to the CLI settings schema**

Find the daemon settings schema (search: `grep -rn "SandboxConfigSchema\|settings" packages/happy-cli/src/persistence.ts`). Add a boolean `terminalEnabled` defaulting to `true` following the existing zod-default pattern in that file.

- [ ] **Step 2: Guard terminal-create**

In `registerTerminalHandlers.ts`, change the `terminal-create` handler to consult the setting (pass the resolved boolean into `registerTerminalHandlers` as a parameter `opts: { terminalEnabled: boolean }`, threaded from `run.ts`):

```typescript
api.registerRpcHandler('terminal-create', (params: TerminalCreateParams) => {
    if (!opts.terminalEnabled) {
        throw new Error('Terminal is disabled on this machine');
    }
    return mgr.create(params);
});
```

Update the function signature to `registerTerminalHandlers(api, machineId, opts: { terminalEnabled: boolean })` and the `run.ts` call site to pass `{ terminalEnabled }` read from settings. Update `registerTerminalHandlers.spec.ts` calls to pass `{ terminalEnabled: true }`.

- [ ] **Step 3: Run CLI tests + typecheck**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec tsc --noEmit && pnpm exec vitest run --project unit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/happy-cli/src
git commit -m "feat(cli): terminalEnabled setting (default on) gating terminal-create"
```

---

### Task 5.2: i18n strings

**Files:**
- Modify: every file in `packages/happy-app/sources/text/translations/` (en, ru, pl, es, ca, it, pt, ja, zh-Hans)

- [ ] **Step 1: Add a `terminal` section to English first**

In `packages/happy-app/sources/text/translations/en.ts`, add:

```typescript
    terminal: {
        title: 'Terminal',
        open: 'Open Terminal',
        ended: 'Terminal ended',
        reconnected: 'Reconnected',
        disabled: 'Terminal is disabled on this machine',
    },
```

- [ ] **Step 2: Mirror into all other languages**

Add the same `terminal` block (translated) to `ru, pl, es, ca, it, pt, ja, zh-Hans`. Use the i18n-translator agent (per happy-app/CLAUDE.md) to translate consistently. zh-Hans example:

```typescript
    terminal: {
        title: '终端',
        open: '打开终端',
        ended: '终端已结束',
        reconnected: '已重连',
        disabled: '此机器已禁用终端',
    },
```

Also add `navigation.connectTerminal`-style entries only if missing (the existing pairing flow already has them — do not duplicate).

- [ ] **Step 3: Typecheck (catches any language missing the key)**

Run: `cd /opt/happy-plus/packages/happy-app && pnpm exec tsc --noEmit`
Expected: PASS (the translation types require every language to have matching keys).

- [ ] **Step 4: Commit**

```bash
git add packages/happy-app/sources/text/translations
git commit -m "feat(app): i18n strings for terminal feature"
```

---

### Task 5.3: CI smoke for node-pty + asset

**Files:**
- Modify: `.github/workflows/cli-smoke-test.yml` (add a node-pty load step)
- Modify: `.github/workflows/typecheck.yml` if it runs app build (ensure `pnpm build:terminal-asset` runs before any web export that needs the asset; the asset is committed, so this is optional but recommended to keep it fresh)

- [ ] **Step 1: Add a node-pty load step to the CLI smoke workflow**

In `.github/workflows/cli-smoke-test.yml`, after dependencies are installed, add a step:

```yaml
      - name: node-pty loads (terminal feature)
        run: |
          cd packages/happy-cli
          node -e "const pty=require('@homebridge/node-pty-prebuilt-multiarch'); const p=pty.spawn('bash',['-c','echo ok'],{cols:80,rows:24}); let out=''; p.onData(d=>out+=d); p.onExit(()=>{ if(!out.includes('ok')){process.exit(1)} });"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/cli-smoke-test.yml
git commit -m "ci: smoke-test node-pty load for terminal feature"
```

---

## Phase 6 — Integration verification (manual)

### Task 6.1: End-to-end manual test checklist

No code; execute against a real daemon + web client (and a device/emulator for native). Record results.

- [ ] **Step 1: Web — basic interactive**

Build/run the web app pointed at the dev server with a daemon running on a machine. Open a machine → "Open Terminal". Verify: prompt appears; `ls`, `echo $SHELL` work; colors render (`ls --color=auto` or `vim`); `Ctrl-C` interrupts a `sleep 100`; tab completion works.

Expected: full interactive behavior.

- [ ] **Step 2: Web — reconnect/replay**

While `top` is running, kill the socket (toggle network / reload the page) and reopen the same terminal via the machine's terminal list. Verify scrollback replays and the live stream resumes.

Expected: same terminal resumes with history (tmux-like).

- [ ] **Step 3: Native — webview terminal**

On an emulator/device, open a terminal. Verify the soft keyboard appears and types into the shell; the accessory bar's `esc`/`ctrl-c`/arrows work (test in `vim` and by interrupting a command); rotation re-fits.

Expected: usable interactive terminal on native.

- [ ] **Step 4: Session entry + cwd**

From a session, open the terminal and run `pwd`. Verify it starts in the session's working directory.

Expected: cwd matches the session.

- [ ] **Step 5: Multiple terminals + close + exit**

Open 2 terminals on one machine (tabs/list), run different commands, close one (verify it's gone from `terminal-list`), and in another type `exit` (verify `terminal-exit` → "Terminal ended" UI).

Expected: independent terminals; clean lifecycle.

- [ ] **Step 6: Disabled setting**

Set `terminalEnabled=false` in the machine's CLI settings, restart the daemon, attempt to open a terminal. Verify the "Terminal is disabled on this machine" error.

Expected: blocked with the message.

- [ ] **Step 7: Commit a short results note**

```bash
# Record outcomes in the PR description or a docs/superpowers/notes file; no code change required.
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §1 full PTY → node-pty (1.1), TerminalManager (1.2). ✓
- §1 two entry points → machine button + session button (4.5). ✓
- §1 persistent + reconnect → scrollback (1.2), attach + seq-gap replay (3.3), manual verify (6.1 step 2). ✓
- §1 unified xterm.js → web .web.tsx + native webview (4.2), asset (4.1). ✓
- §2 dual transport → RPC ops (3.2) + streaming events (1.5, 2.1, 3.1). ✓
- §3.1 encryption (machine key) → daemon enc (1.5), app enc (3.1). ✓
- §3.2 RPC methods → 1.5 (daemon), 3.2 (app). ✓
- §3.3 streaming events → 1.5, 2.1, 3.1. ✓
- §3.4 TerminalSession + seq + cap + concurrent cap → 1.2. ✓
- §3.5 node-pty packaging → 1.1 + CI 5.3. ✓
- §4 UI (component, hook, entry points, accessory bar, asset) → 3.3, 4.1–4.5. ✓
- §5.1 lifecycle/flow control → coalescer (1.3), wiring (1.5). ✓
- §5.2 security/ownership/toggle → routing-based ownership (2.1), toggle (5.1). ✓
- §5.3 testing → unit tests in 1.2–3.3, server 2.1, manual 6.1; CI 5.3. ✓
- §6 touch-points → covered across tasks.
- §7 risks → node-pty (1.1/5.3), webview bridging (4.2/6.1 step 3), throughput (1.3).

**Placeholder scan:** No TBD/TODO; all code blocks concrete. Two intentional "match existing field names" notes (4.5 session metadata, 5.1 settings schema) point at exact search commands rather than leaving blanks.

**Type consistency:** Event names and payload shapes match across daemon (1.5), server (2.1), app (3.1, 3.3). RPC method names identical in 1.5 and 3.2. `TerminalSink`/`TerminalViewHandle`/`TerminalController` names consistent across 3.3, 4.2, 4.4.
