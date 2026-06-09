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
