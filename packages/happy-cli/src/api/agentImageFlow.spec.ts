import { describe, it, expect, vi } from 'vitest';
import { processPendingImages } from './apiSession';

function deps() {
    return {
        upload: vi.fn().mockResolvedValue({ ref: 'att/img1', size: 123 }),
        emitFileEnvelope: vi.fn(),
        emitTextEnvelope: vi.fn(),
    };
}

describe('processPendingImages', () => {
    it('uploads and emits a file envelope with dimensions for a PNG', async () => {
        const d = deps();
        // PNG header (enough for getImageSize): signature+IHDR w=300 h=200
        const buf = Buffer.alloc(29);
        buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
        buf.writeUInt32BE(13, 8); buf.write('IHDR', 12, 'ascii');
        buf.writeUInt32BE(300, 16); buf.writeUInt32BE(200, 20);
        const base64 = buf.toString('base64');

        await processPendingImages([{ base64, mediaType: 'image/png' }], d);

        expect(d.upload).toHaveBeenCalledTimes(1);
        const call = d.emitFileEnvelope.mock.calls[0][0];
        expect(call.ref).toBe('att/img1');
        expect(call.mimeType).toBe('image/png');
        expect(call.name).toMatch(/^image-.*\.png$/);
        expect(call.image).toEqual({ width: 300, height: 200 });
    });

    it('emits a placeholder text when image exceeds 10MB', async () => {
        const d = deps();
        const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
        await processPendingImages([{ base64: big, mediaType: 'image/png' }], d);
        expect(d.upload).not.toHaveBeenCalled();
        expect(d.emitTextEnvelope).toHaveBeenCalledWith('[image: too large to display]');
    });

    it('emits a placeholder text when upload fails', async () => {
        const d = deps();
        d.upload.mockRejectedValueOnce(new Error('boom'));
        await processPendingImages([{ base64: 'aGVsbG8=', mediaType: 'image/png' }], d);
        expect(d.emitTextEnvelope).toHaveBeenCalledWith('[image: upload failed]');
        expect(d.emitFileEnvelope).not.toHaveBeenCalled();
    });
});
