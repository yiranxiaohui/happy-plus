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
