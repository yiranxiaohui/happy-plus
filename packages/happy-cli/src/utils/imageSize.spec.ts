import { describe, it, expect } from 'vitest';
import { getImageSize } from './imageSize';

// Build a minimal valid PNG header: signature + IHDR chunk with w=300,h=200.
function pngHeader(width: number, height: number): Uint8Array {
    const buf = Buffer.alloc(8 + 8 + 13);
    buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
    buf.writeUInt32BE(13, 8);            // IHDR length
    buf.write('IHDR', 12, 'ascii');
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    return new Uint8Array(buf);
}

// Build a minimal JPEG: SOI + APP0 stub + SOF0 with h=120,w=80.
function jpegHeader(width: number, height: number): Uint8Array {
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]); // APP0, len 4
    const sof0 = Buffer.alloc(2 + 2 + 5 + 2);
    sof0.set([0xff, 0xc0], 0);           // SOF0 marker
    sof0.writeUInt16BE(2 + 5 + 2, 2);    // segment length (excl. marker)
    sof0.writeUInt8(8, 4);               // bit depth
    sof0.writeUInt16BE(height, 5);
    sof0.writeUInt16BE(width, 7);
    return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]));
}

describe('getImageSize', () => {
    it('parses PNG IHDR dimensions', () => {
        expect(getImageSize(pngHeader(300, 200))).toEqual({ width: 300, height: 200 });
    });
    it('parses JPEG SOF0 dimensions', () => {
        expect(getImageSize(jpegHeader(80, 120))).toEqual({ width: 80, height: 120 });
    });
    it('returns null for garbage', () => {
        expect(getImageSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull();
    });
});
