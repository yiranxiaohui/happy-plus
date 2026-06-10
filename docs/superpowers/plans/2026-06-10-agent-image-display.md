# Agent Image Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Images returned by Claude (tool-result images from `Read`/screenshots, and assistant `image` blocks) become visible in the Happy app/web.

**Architecture:** The CLI's session protocol mapper gains image branches that collect pending images (sync, pure); `sendClaudeSessionMessage` consumes them asynchronously — encrypt with the session blob key, upload via the attachments API (request-upload → PUT/POST), then emit the existing wire `file` envelope with the ref. Server: zero changes. App: zero functional changes (the `file` envelope path already parses and renders agent-role images via FileView); only schema alignment for an optional `thumbhash`.

**Tech Stack:** TypeScript, tweetnacl (CLI secretbox), axios (CLI HTTP), zod (wire schema), vitest.

**Spec:** `docs/superpowers/specs/2026-06-10-agent-image-display-design.md`

---

## Locked constants & shapes (keep consistent across tasks)

- Max decoded image size: `MAX_AGENT_IMAGE_BYTES = 10 * 1024 * 1024`.
- Placeholder texts (CLI-emitted plain text envelopes): `[image: too large to display]`, `[image: upload failed]`.
- Pending image item: `{ base64: string; mediaType: string }` (type `PendingImage`, exported from the mapper).
- Mapper result gains `pendingImages: PendingImage[]` (always present, possibly empty).
- File name for uploaded agent images: `image-<n>.<ext>` where ext from mediaType (`image/png`→`png`, `image/jpeg`→`jpg`, `image/webp`→`webp`, `image/gif`→`gif`, else `bin`), `<n>` = a short cuid suffix.
- Blob wire format (matches existing `decryptBlob` / app `encryptBlob`): `[nonce(24)][secretbox ciphertext]`, key = `deriveKey(encryptionKey, 'Happy Blobs', ['session'|'master'])` (already implemented as `getBlobKey()`).

---

## Task 1: CLI `encryptBlob` (binary secretbox, mirrors existing `decryptBlob`)

**Files:**
- Modify: `packages/happy-cli/src/api/encryption.ts` (add function next to `decryptBlob`, ~line 119)
- Test: `packages/happy-cli/src/api/encryptBlob.spec.ts` (new)

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/api/encryptBlob.spec.ts`
Expected: FAIL — `encryptBlob` is not exported.

- [ ] **Step 3: Implement (add to `encryption.ts`, right above `decryptBlob`)**

```typescript
/**
 * Encrypt a binary blob with NaCl crypto_secretbox (XSalsa20-Poly1305).
 * Wire format: [nonce (24 bytes)] [ciphertext + auth tag (16 bytes + data)]
 * Mirror of decryptBlob below and of the app-side encryptBlob()
 * (packages/happy-app/sources/encryption/blob.ts).
 */
export function encryptBlob(data: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = tweetnacl.randomBytes(tweetnacl.secretbox.nonceLength);
  const ciphertext = tweetnacl.secretbox(data, nonce, key);
  const bundle = new Uint8Array(nonce.length + ciphertext.length);
  bundle.set(nonce, 0);
  bundle.set(ciphertext, nonce.length);
  return bundle;
}
```

(`tweetnacl` is already imported in this file — reuse the existing import.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/api/encryptBlob.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/api/encryption.ts packages/happy-cli/src/api/encryptBlob.spec.ts
git commit -m "feat(cli): encryptBlob — binary secretbox mirror of decryptBlob"
```

---

## Task 2: CLI image dimension parser (PNG IHDR / JPEG SOFn)

**Files:**
- Create: `packages/happy-cli/src/utils/imageSize.ts`
- Test: `packages/happy-cli/src/utils/imageSize.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/utils/imageSize.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `imageSize.ts`**

```typescript
/**
 * Parse image pixel dimensions from PNG (IHDR) or JPEG (SOFn) headers.
 * Lightweight, dependency-free; returns null when the format is unknown
 * or the header is malformed — callers then omit dimension metadata.
 */
export function getImageSize(data: Uint8Array): { width: number; height: number } | null {
    // PNG: 8-byte signature, then IHDR chunk: len(4) 'IHDR'(4) width(4) height(4)
    if (data.length >= 24 &&
        data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        if (String.fromCharCode(data[12], data[13], data[14], data[15]) === 'IHDR') {
            return { width: view.getUint32(16), height: view.getUint32(20) };
        }
        return null;
    }

    // JPEG: SOI then segments; SOFn (0xC0-0xCF except C4/C8/CC) carries dimensions.
    if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let offset = 2;
        while (offset + 9 < data.length) {
            if (data[offset] !== 0xff) return null;
            const marker = data[offset + 1];
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return {
                    height: view.getUint16(offset + 5),
                    width: view.getUint16(offset + 7),
                };
            }
            const segLen = view.getUint16(offset + 2);
            if (segLen < 2) return null;
            offset += 2 + segLen;
        }
        return null;
    }

    return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/utils/imageSize.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/utils/imageSize.ts packages/happy-cli/src/utils/imageSize.spec.ts
git commit -m "feat(cli): PNG/JPEG header dimension parser for agent images"
```

---

## Task 3: wire — make `image.thumbhash` optional on the file event

The CLI won't generate thumbhash (spec non-goal), but `sessionFileEventSchema.image.thumbhash` is currently REQUIRED — `createEnvelope` runs `sessionEnvelopeSchema.parse(...)`, so a thumbhash-less image would throw. FileView already treats thumbhash as optional.

**Files:**
- Modify: `packages/happy-wire/src/sessionProtocol.ts` (~line 52)
- Check/modify: app-side mirror schema in `packages/happy-app/sources/sync/typesRaw.ts` (~line 60, the `t: z.literal('file')` schema) — if it also requires thumbhash, make it optional there too.

- [ ] **Step 1: Edit wire schema**

In `packages/happy-wire/src/sessionProtocol.ts`, change inside `sessionFileEventSchema`:

```typescript
  image: z
    .object({
      width: z.number(),
      height: z.number(),
      thumbhash: z.string().optional(),
    })
    .optional(),
```

(only the `.optional()` on `thumbhash` is new.)

- [ ] **Step 2: Check the app mirror schema**

Run: `grep -n "thumbhash" packages/happy-app/sources/sync/typesRaw.ts`
If the file-event schema there has `thumbhash: z.string()` without `.optional()`, add `.optional()`. The downstream read at ~line 684 (`thumbhash: envelope.ev.image.thumbhash`) already tolerates `undefined` (field becomes undefined in metadata; FileView's schema has it optional).

- [ ] **Step 3: Rebuild wire + typecheck both consumers**

```bash
cd /opt/happy-plus && pnpm --filter @slopus/happy-wire build
cd packages/happy-cli && pnpm exec tsc --noEmit
cd ../happy-app && pnpm exec tsc --noEmit
```
Expected: build OK, both typechecks clean.

- [ ] **Step 4: Commit**

```bash
git add packages/happy-wire/src/sessionProtocol.ts packages/happy-app/sources/sync/typesRaw.ts
git commit -m "fix(wire): file event image.thumbhash optional (CLI doesn't generate it)"
```

---

## Task 4: CLI `uploadAttachment` on ApiSessionClient

**Files:**
- Modify: `packages/happy-cli/src/api/apiSession.ts` (add method next to `downloadAttachment`, ~line 287; extend the './encryption' import with `encryptBlob`)
- Test: `packages/happy-cli/src/api/uploadAttachment.spec.ts` (new; axios mocked)

- [ ] **Step 1: Write the failing test**

```typescript
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
        // request-upload call shape
        expect((axios.post as any).mock.calls[0][0]).toContain('/v1/sessions/s1/attachments/request-upload');
        expect((axios.post as any).mock.calls[0][1]).toMatchObject({ filename: 'image-x.png' });
        // PUT body is encrypted (decryptable with blobKey, round-trips to data)
        const putArgs = (axios.put as any).mock.calls[0];
        expect(putArgs[0]).toBe('https://happy.example/v1/sessions/s1/attachments/att-abc');
        const sent = new Uint8Array(putArgs[1]);
        const back = decryptBlob(sent, blobKey);
        expect(Array.from(back!)).toEqual([9, 9, 9]);
        // Bearer present because uploadUrl is on the server host
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/api/uploadAttachment.spec.ts`
Expected: FAIL — `uploadSessionAttachment` not exported.

- [ ] **Step 3: Implement**

Add to `apiSession.ts` as an **exported standalone function** (testable without constructing the heavy client class) plus a thin class method:

```typescript
/**
 * Encrypt and upload a session attachment blob.
 * Mirrors the app's request-upload → PUT/POST flow (apiAttachments.ts) and
 * the download direction implemented above. Returns the storage ref to put
 * in a `file` envelope. Exported standalone for testability.
 */
export async function uploadSessionAttachment(opts: {
    serverUrl: string;
    sessionId: string;
    token: string;
    blobKey: Uint8Array;
    data: Uint8Array;
    filename: string;
}): Promise<{ ref: string; size: number }> {
    const encrypted = encryptBlob(opts.data, opts.blobKey);

    const requestRes = await axios.post(
        `${opts.serverUrl}/v1/sessions/${opts.sessionId}/attachments/request-upload`,
        { filename: opts.filename, size: encrypted.length },
        { headers: { 'Authorization': `Bearer ${opts.token}`, 'Content-Type': 'application/json' }, timeout: 30000 },
    );
    const { ref, uploadUrl, method, formFields } = requestRes.data ?? {};
    if (typeof ref !== 'string' || typeof uploadUrl !== 'string') {
        throw new Error('request-upload returned no ref/uploadUrl');
    }

    if (method === 'POST') {
        // S3 presigned POST policy: multipart form with policy fields + file.
        const form = new FormData();
        for (const [k, v] of Object.entries((formFields ?? {}) as Record<string, string>)) {
            form.append(k, v);
        }
        form.append('file', new Blob([encrypted], { type: 'application/octet-stream' }), 'blob');
        await axios.post(uploadUrl, form, { timeout: 60000 });
    } else {
        // PUT (local-storage mode) — Bearer only when uploading to our own server.
        const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
        if (uploadUrl.startsWith(opts.serverUrl)) {
            headers['Authorization'] = `Bearer ${opts.token}`;
        }
        // Standalone copy: never send a view onto a larger parent buffer.
        const standalone = new Uint8Array(encrypted);
        await axios.put(uploadUrl, standalone.buffer, { headers, timeout: 60000, maxBodyLength: Infinity });
    }

    return { ref, size: encrypted.length };
}
```

And inside the `ApiSessionClient` class (next to `downloadAndDecryptAttachment`):

```typescript
    /** Encrypt + upload an attachment for this session; returns the storage ref. */
    async uploadAttachment(data: Uint8Array, filename: string): Promise<{ ref: string; size: number }> {
        const blobKey = await this.getBlobKey();
        return uploadSessionAttachment({
            serverUrl: configuration.serverUrl,
            sessionId: this.sessionId,
            token: this.token,
            blobKey,
            data,
            filename,
        });
    }
```

Extend the existing import: `import { decodeBase64, decryptBlob, decrypt, encodeBase64, encrypt, encryptBlob } from './encryption';`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/api/uploadAttachment.spec.ts && pnpm exec tsc --noEmit`
Expected: PASS (2 tests), tsc clean. (If Node's global `FormData`/`Blob` typing complains under the CLI tsconfig, cast minimally — Node 20 has both globals.)

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/api/apiSession.ts packages/happy-cli/src/api/uploadAttachment.spec.ts
git commit -m "feat(cli): uploadAttachment — encrypted session attachment upload"
```

---

## Task 5: mapper image branches + `pendingImages`

**Files:**
- Modify: `packages/happy-cli/src/claude/utils/sessionProtocolMapper.ts`
- Test: extend `packages/happy-cli/src/claude/utils/sessionProtocolMapper.test.ts`

- [ ] **Step 1: Write the failing tests (append to the existing describe block)**

```typescript
    it('collects assistant image blocks into pendingImages', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-img',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'here is a chart' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
                ],
            },
            timestamp: '2025-01-01T00:00:02.000Z',
        } as any, { currentTurnId: null });

        expect(result.pendingImages).toEqual([
            { base64: 'aGVsbG8=', mediaType: 'image/png' },
        ]);
        // text still mapped normally
        expect(result.envelopes.some(e => e.ev.t === 'text')).toBe(true);
    });

    it('collects tool_result image blocks into pendingImages', () => {
        const state = { currentTurnId: 't-1' };
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-img',
            message: {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'call-9',
                    content: [
                        { type: 'text', text: 'read 1 image' },
                        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'd29ybGQ=' } },
                    ],
                }],
            },
            timestamp: '2025-01-01T00:00:03.000Z',
        } as any, state as any);

        expect(result.pendingImages).toEqual([
            { base64: 'd29ybGQ=', mediaType: 'image/jpeg' },
        ]);
        // tool-call-end still emitted
        expect(result.envelopes.some(e => e.ev.t === 'tool-call-end')).toBe(true);
    });

    it('returns empty pendingImages when no images present', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-2',
            message: { role: 'user', content: 'plain' },
            timestamp: '2025-01-01T00:00:04.000Z',
        } as any, { currentTurnId: null });
        expect(result.pendingImages).toEqual([]);
    });
```

- [ ] **Step 2: Run to verify failures**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/claude/utils/sessionProtocolMapper.test.ts`
Expected: new tests FAIL (`pendingImages` undefined).

- [ ] **Step 3: Implement**

In `sessionProtocolMapper.ts`:

1. Export the item type and extend the result type:

```typescript
export type PendingImage = {
    base64: string;
    mediaType: string;
};

type ClaudeMapperResult = {
    currentTurnId: string | null;
    envelopes: SessionEnvelope[];
    pendingImages: PendingImage[];
};
```

2. Add a module-level helper:

```typescript
function collectImageBlock(block: any, pendingImages: PendingImage[]): boolean {
    if (block?.type === 'image' &&
        block.source?.type === 'base64' &&
        typeof block.source.data === 'string' &&
        typeof block.source.media_type === 'string') {
        pendingImages.push({ base64: block.source.data, mediaType: block.source.media_type });
        return true;
    }
    return false;
}
```

3. In `mapClaudeLogMessageToSessionEnvelopesInternal`, create `const pendingImages: PendingImage[] = [];` at the top and include `pendingImages` in **every** `return { currentTurnId, envelopes }` site (there are several — update them all to `return { currentTurnId: state.currentTurnId, envelopes, pendingImages };` keeping each site's existing currentTurnId expression).

4. In the **assistant blocks loop** (after the `thinking` branch, before `tool_use`):

```typescript
            if (collectImageBlock(block, pendingImages)) {
                continue;
            }
```

5. In the **user/tool_result branch**: inside the `block.type === 'tool_result'` case, before pushing `tool-call-end`, scan its content array:

```typescript
                if (Array.isArray(block.content)) {
                    for (const inner of block.content) {
                        collectImageBlock(inner, pendingImages);
                    }
                }
```

6. The internal recursion sites (buffered subagent replays call `mapClaudeLogMessageToSessionEnvelopesInternal` and spread `.envelopes`) must also merge child `pendingImages`: where the code does `envelopes.push(...replay.envelopes)`, add `pendingImages.push(...replay.pendingImages);`.

7. `closeClaudeTurnWithStatus` (if it returns the same result shape) gets `pendingImages: []`.

- [ ] **Step 4: Run all mapper tests**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/claude/utils/sessionProtocolMapper.test.ts && pnpm exec tsc --noEmit`
Expected: ALL mapper tests pass (old + 3 new), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/claude/utils/sessionProtocolMapper.ts packages/happy-cli/src/claude/utils/sessionProtocolMapper.test.ts
git commit -m "feat(cli): mapper collects agent image blocks as pendingImages"
```

---

## Task 6: `sendClaudeSessionMessage` consumes pendingImages

**Files:**
- Modify: `packages/happy-cli/src/api/apiSession.ts` (`sendClaudeSessionMessage`, ~line 500; add private helper)
- Test: `packages/happy-cli/src/api/agentImageFlow.spec.ts` (new — exercises the helper directly)

- [ ] **Step 1: Write the failing test**

The async consumption logic lives in an exported pure-ish helper so it's testable without the full client:

```typescript
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
        // 1x1 PNG header (enough for getImageSize): signature+IHDR w=300 h=200
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/api/agentImageFlow.spec.ts`
Expected: FAIL — `processPendingImages` not exported.

- [ ] **Step 3: Implement**

In `apiSession.ts` add (top-level export; import `getImageSize` from `@/utils/imageSize`, `createId` from `@paralleldrive/cuid2` — already a CLI dependency, see mapper test imports):

```typescript
const MAX_AGENT_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_EXT: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

/**
 * Upload agent-produced images and emit `file` envelopes (or placeholder
 * text on failure). Extracted from the client class for testability —
 * the deps are tiny closures bound to a session.
 */
export async function processPendingImages(
    images: Array<{ base64: string; mediaType: string }>,
    deps: {
        upload: (data: Uint8Array, filename: string) => Promise<{ ref: string; size: number }>;
        emitFileEnvelope: (file: { ref: string; name: string; size: number; mimeType: string; image?: { width: number; height: number } }) => void;
        emitTextEnvelope: (text: string) => void;
    },
): Promise<void> {
    for (const img of images) {
        let data: Uint8Array;
        try {
            data = new Uint8Array(Buffer.from(img.base64, 'base64'));
        } catch {
            deps.emitTextEnvelope('[image: upload failed]');
            continue;
        }
        if (data.length > MAX_AGENT_IMAGE_BYTES) {
            deps.emitTextEnvelope('[image: too large to display]');
            continue;
        }
        const ext = IMAGE_EXT[img.mediaType] ?? 'bin';
        const name = `image-${createId().slice(0, 8)}.${ext}`;
        try {
            const { ref, size } = await deps.upload(data, name);
            const dims = getImageSize(data);
            deps.emitFileEnvelope({
                ref, name, size, mimeType: img.mediaType,
                ...(dims ? { image: dims } : {}),
            });
        } catch (error) {
            logger.debug('[SOCKET] Agent image upload failed:', error);
            deps.emitTextEnvelope('[image: upload failed]');
        }
    }
}
```

Then wire into `sendClaudeSessionMessage` — after the existing envelope loop, fire-and-forget (the method is sync; never block or throw):

```typescript
        if (mapped.pendingImages.length > 0) {
            const turn = this.claudeSessionProtocolState.currentTurnId ?? undefined;
            void processPendingImages(mapped.pendingImages, {
                upload: (data, filename) => this.uploadAttachment(data, filename),
                emitFileEnvelope: (file) => {
                    this.sendSessionProtocolMessage(createEnvelope('agent', { t: 'file', ...file }, turn ? { turn } : {}));
                },
                emitTextEnvelope: (text) => {
                    this.sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text }, turn ? { turn } : {}));
                },
            }).catch((error) => {
                logger.debug('[SOCKET] processPendingImages crashed:', error);
            });
        }
```

(`createEnvelope` import: extend the existing `@slopus/happy-wire` import in apiSession.ts — check what it currently imports and add `createEnvelope` if missing.)

- [ ] **Step 4: Run tests + typecheck + full unit suite**

Run: `cd /opt/happy-plus/packages/happy-cli && pnpm exec vitest run src/api/agentImageFlow.spec.ts && pnpm exec tsc --noEmit && pnpm exec vitest run --project unit`
Expected: 3 new tests pass; tsc clean; full suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/api/apiSession.ts packages/happy-cli/src/api/agentImageFlow.spec.ts
git commit -m "feat(cli): upload agent images and emit file envelopes"
```

---

## Task 7: app verification (expected zero functional change)

**Files:**
- Possibly modify: `packages/happy-app/sources/sync/typesRaw.ts` (only if Task 3 Step 2 found a required thumbhash — already handled there)
- No new components.

- [ ] **Step 1: Confirm the app accepts a thumbhash-less file envelope**

Run: `cd /opt/happy-plus/packages/happy-app && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: clean/green. (`typesRaw.ts:677` reads `envelope.ev.image.thumbhash` — `undefined` flows into metadata; `FileView`'s `fileInputSchema` has `thumbhash: z.string().optional()`; `useAttachmentImage` is role-agnostic.)

- [ ] **Step 2: Commit (only if a change was needed and not already committed in Task 3)**

```bash
git status --short  # if typesRaw.ts changed in Task 3 it's already committed; nothing to do here
```

---

## Task 8: Full verification + manual E2E checklist

- [ ] **Step 1: All suites**

```bash
cd /opt/happy-plus/packages/happy-cli && pnpm exec tsc --noEmit && pnpm exec vitest run --project unit
cd ../happy-app && pnpm exec tsc --noEmit && pnpm exec vitest run
cd ../happy-server && pnpm exec tsc --noEmit && pnpm exec vitest run
cd ../happy-wire && pnpm exec vitest run 2>/dev/null || true   # wire tests if present
```
Expected: everything green.

- [ ] **Step 2: Manual E2E (after release + CLI upgrade on a machine)**

1. In a session on an upgraded machine, ask Claude: "Read /path/to/some.png and describe it" → the image appears inline in app/web (FileView bubble) right after the tool call.
2. Assistant-image path (if reproducible): any flow where Claude emits an image block → image appears.
3. Kill network to the server mid-upload (or point at a bad URL in a dev run) → chat shows `[image: upload failed]`, conversation continues normally.
4. A >10MB image → `[image: too large to display]`.

- [ ] **Step 3: Release note**

Ships in the next unified `vX.Y.Z` (CLI npm + server image rebuild for the bundled web; server code unchanged). Machines must upgrade `happy-plus` CLI to emit images; old CLIs keep current (dropping) behavior — no breakage either way.

---

## Self-Review (completed by plan author)

**Spec coverage:** §1 gaps → Tasks 5 (mapper) + 7 (app verify). §2 attachment-ref decision → Tasks 4+6. §3 both sources → Task 5 (two branches+tests). §4 flow → Tasks 4/5/6. §5.1 upload → Task 4. §5.2 queue → Tasks 5+6. §5.3 dimensions → Task 2 (+optional thumbhash, Task 3). §5.4 limits/failure → Task 6 (cap + placeholders, tests). §6 app verify → Task 7. §7 tests → Tasks 1–6 unit + Task 8 manual. §8 release → Task 8 Step 3. §9 non-goals respected (no thumbhash generation — wire made optional instead; no server changes).

**Placeholder scan:** none — all code concrete; the two "check what it imports" notes give exact commands/locations.

**Type consistency:** `PendingImage {base64, mediaType}` consistent across Tasks 5/6; `uploadSessionAttachment` opts shape consistent between Task 4 impl and test; `processPendingImages` deps shape consistent between Task 6 test and impl; placeholders exactly `[image: too large to display]` / `[image: upload failed]` in both test and impl.
