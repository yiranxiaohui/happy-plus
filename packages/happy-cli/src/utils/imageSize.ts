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
