import { describe, it, expect } from 'vitest';
import { encryptBlob, decryptBlob } from './encryption';

describe('encryptBlob', () => {
    it('round-trips a binary blob with decryptBlob', () => {
        const key = new Uint8Array(32).fill(7);
        const data = new Uint8Array([1, 2, 3, 250, 251, 252, 0, 0, 9]);
        const bundle = encryptBlob(data, key);
        // wire format: nonce(24) + ciphertext(len+16)
        expect(bundle.length).toBe(24 + data.length + 16);
        const back = decryptBlob(bundle, key);
        expect(back).not.toBeNull();
        expect(Array.from(back!)).toEqual(Array.from(data));
    });

    it('produces different ciphertexts for the same input (random nonce)', () => {
        const key = new Uint8Array(32).fill(7);
        const data = new Uint8Array([1, 2, 3]);
        const a = encryptBlob(data, key);
        const b = encryptBlob(data, key);
        expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
    });
});
