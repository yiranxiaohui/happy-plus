/**
 * Tests for PermissionHandler permission-mode branches.
 *
 * Focus: the `dontAsk` mode must DENY any tool that is not pre-approved by the
 * allowlist, WITHOUT prompting the user (mirrors the SDK's 'dontAsk' semantics:
 * don't prompt, deny if not pre-approved). This is the fork's fix for `dontAsk`
 * being silently treated as "ask every time".
 *
 * `handleToolCall`'s mode branches are pure synchronous logic that never touch
 * the session, so we construct the handler with a minimal session whose only
 * job is to satisfy the constructor's `registerHandler` call. This is not an
 * API mock — no network/RPC behavior is exercised by these tests.
 */
import { describe, it, expect } from 'vitest';
import { PermissionHandler } from './permissionHandler';
import type { EnhancedMode } from '../loop';

// Minimal session: the constructor only calls
// session.client.rpcHandlerManager.registerHandler(...). Nothing else is used
// by the code paths under test.
function makeHandler(): PermissionHandler {
    const session = {
        client: {
            rpcHandlerManager: {
                registerHandler: () => {},
            },
        },
    } as any;
    return new PermissionHandler(session);
}

const MODE: EnhancedMode = { permissionMode: 'dontAsk' };

function callOpts() {
    return { signal: new AbortController().signal, toolUseID: `t_${Math.random().toString(36).slice(2)}` };
}

describe('PermissionHandler dontAsk mode', () => {
    it('denies a non-pre-approved tool synchronously without prompting', async () => {
        const handler = makeHandler();
        handler.handleModeChange('dontAsk');

        // Race against a microtask-resolved sentinel: a real prompt would return
        // a Promise that stays pending (it awaits an RPC response that never
        // arrives here), so if we got a value at all it must be the deny branch.
        const result = await Promise.race([
            handler.handleToolCall('Bash', { command: 'rm -rf /' }, MODE, callOpts()),
            new Promise((resolve) => setTimeout(() => resolve('PENDING'), 50)),
        ]);

        expect(result).not.toBe('PENDING');
        expect(result).toMatchObject({ behavior: 'deny' });
    });

    it('denies a dangerous Edit tool under dontAsk', async () => {
        const handler = makeHandler();
        handler.handleModeChange('dontAsk');

        const result = await handler.handleToolCall(
            'Write',
            { file_path: '/etc/passwd', content: 'x' },
            MODE,
            callOpts(),
        );

        expect(result).toMatchObject({ behavior: 'deny' });
    });
});
