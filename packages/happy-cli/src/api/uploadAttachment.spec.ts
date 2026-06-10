import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => ({
    default: { post: vi.fn(), put: vi.fn(), get: vi.fn() },
}));

import axios from 'axios';
import { uploadSessionAttachment } from './apiSession';
import { encryptBlob, decryptBlob } from './encryption';

describe('uploadSessionAttachment', () => {
    beforeEach(() => vi.clearAllMocks());

    it('requests upload, PUTs encrypted blob with auth on server URLs, returns ref', async () => {
        (axios.post as any).mockResolvedValueOnce({
            data: { ref: 'att/abc', uploadUrl: 'https://happy.example/v1/sessions/s1/attachments/att-abc', method: 'PUT' },
        });
        (axios.put as any).mockResolvedValueOnce({ status: 200 });

        const blobKey = new Uint8Array(32).fill(3);
        const data = new Uint8Array([9, 9, 9]);
        const result = await uploadSessionAttachment({
            serverUrl: 'https://happy.example',
            sessionId: 's1',
            token: 'tok',
            blobKey,
            data,
            filename: 'image-x.png',
        });

        expect(result.ref).toBe('att/abc');
        expect((axios.post as any).mock.calls[0][0]).toContain('/v1/sessions/s1/attachments/request-upload');
        expect((axios.post as any).mock.calls[0][1]).toMatchObject({ filename: 'image-x.png' });
        const putArgs = (axios.put as any).mock.calls[0];
        expect(putArgs[0]).toBe('https://happy.example/v1/sessions/s1/attachments/att-abc');
        const sent = new Uint8Array(putArgs[1]);
        const back = decryptBlob(sent, blobKey);
        expect(Array.from(back!)).toEqual([9, 9, 9]);
        expect(putArgs[2].headers.Authorization).toBe('Bearer tok');
    });

    it('throws when request-upload returns no uploadUrl', async () => {
        (axios.post as any).mockResolvedValueOnce({ data: {} });
        await expect(uploadSessionAttachment({
            serverUrl: 'https://happy.example', sessionId: 's1', token: 'tok',
            blobKey: new Uint8Array(32), data: new Uint8Array([1]), filename: 'a.png',
        })).rejects.toThrow();
    });
});
