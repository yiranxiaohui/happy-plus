import { describe, it, expect } from 'vitest';
import { BIN_NAME } from './binName';

describe('BIN_NAME', () => {
    it('is a non-empty command name', () => {
        expect(typeof BIN_NAME).toBe('string');
        expect(BIN_NAME.length).toBeGreaterThan(0);
        expect(BIN_NAME).not.toMatch(/\.(mjs|cjs|js|ts)$/);
    });
});
