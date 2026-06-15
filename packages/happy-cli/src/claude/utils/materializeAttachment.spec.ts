import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sanitizeAttachmentName, materializeAttachment, ensureHappyExcluded } from './materializeAttachment';

describe('sanitizeAttachmentName', () => {
    it('keeps a plain filename', () => {
        expect(sanitizeAttachmentName('data.csv')).toBe('data.csv');
    });
    it('strips directory components (path traversal)', () => {
        expect(sanitizeAttachmentName('../../etc/passwd')).toBe('passwd');
        expect(sanitizeAttachmentName('/abs/path/to/x.bin')).toBe('x.bin');
        expect(sanitizeAttachmentName('a\\b\\c.txt')).toBe('c.txt');
    });
    it('falls back to "file" for empty/dotted names', () => {
        expect(sanitizeAttachmentName('')).toBe('file');
        expect(sanitizeAttachmentName('..')).toBe('file');
        expect(sanitizeAttachmentName('/')).toBe('file');
    });
});

describe('materializeAttachment', () => {
    it('writes bytes under .happy/uploads and returns a relative path', async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'happy-mat-'));
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const rel = await materializeAttachment(cwd, 'report.pdf', bytes, 'abcd1234');
        expect(rel).toBe('./.happy/uploads/abcd1234-report.pdf');
        const written = await fs.readFile(path.join(cwd, '.happy', 'uploads', 'abcd1234-report.pdf'));
        expect(new Uint8Array(written)).toEqual(bytes);
    });
});

describe('ensureHappyExcluded', () => {
    it('appends .happy/ to .git/info/exclude exactly once', async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'happy-git-'));
        await fs.mkdir(path.join(cwd, '.git', 'info'), { recursive: true });
        await fs.writeFile(path.join(cwd, '.git', 'info', 'exclude'), '# existing\n');
        await ensureHappyExcluded(cwd);
        await ensureHappyExcluded(cwd); // idempotent
        const content = await fs.readFile(path.join(cwd, '.git', 'info', 'exclude'), 'utf8');
        expect(content.match(/^\.happy\/$/gm)?.length).toBe(1);
    });
    it('no-ops when there is no .git directory', async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'happy-nogit-'));
        await expect(ensureHappyExcluded(cwd)).resolves.toBeUndefined();
    });
});
