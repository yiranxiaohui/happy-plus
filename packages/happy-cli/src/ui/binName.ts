import * as path from 'node:path';

/**
 * The command name the user actually invoked (e.g. 'happy' upstream/dev,
 * 'happy-plus' for the fork's published bin). Used in help/usage text so
 * printed commands are actually runnable. Falls back to 'happy'.
 */
export const BIN_NAME = (() => {
    // bin/happy.mjs re-spawns node with dist/index.mjs as argv[1], so it
    // forwards the originally invoked bin name via this env var.
    const fromEnv = process.env.HAPPY_BIN_NAME;
    if (fromEnv) return fromEnv;
    const argv1 = process.argv[1] || '';
    const base = path.basename(argv1).replace(/\.(mjs|cjs|js|ts)$/, '');
    // When run via tsx/node directly (dev), argv[1] is the script file, not a bin.
    if (!base || base === 'index' || base === 'happy-coder') return 'happy';
    return base;
})();
