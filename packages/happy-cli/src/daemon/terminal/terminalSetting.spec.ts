import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point persistence at an isolated, empty HAPPY_HOME_DIR *before* importing the
// configuration singleton (constructed from env at import time).
const tmpHome = mkdtempSync(join(tmpdir(), 'happy-terminal-setting-'));
process.env.HAPPY_HOME_DIR = tmpHome;

// Imported after env is set so `configuration.settingsFile` resolves into tmpHome.
const { readSettings } = await import('@/persistence');
const { configuration } = await import('@/configuration');

describe('terminalEnabled setting', () => {
    beforeAll(() => {
        mkdirSync(configuration.happyHomeDir, { recursive: true });
    });

    afterAll(() => {
        rmSync(tmpHome, { recursive: true, force: true });
    });

    it('defaults to true when no settings file exists', async () => {
        const settings = await readSettings();
        expect(settings.terminalEnabled).toBe(true);
    });

    it('defaults to true when omitted from an existing settings file', async () => {
        writeFileSync(
            configuration.settingsFile,
            JSON.stringify({ schemaVersion: 2, onboardingCompleted: true }),
        );
        const settings = await readSettings();
        expect(settings.terminalEnabled).toBe(true);
    });

    it('can be disabled', async () => {
        writeFileSync(
            configuration.settingsFile,
            JSON.stringify({ schemaVersion: 2, onboardingCompleted: true, terminalEnabled: false }),
        );
        const settings = await readSettings();
        expect(settings.terminalEnabled).toBe(false);
    });
});
