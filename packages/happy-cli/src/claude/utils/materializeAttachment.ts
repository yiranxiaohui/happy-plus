/**
 * Materialize a non-image attachment to disk so a coding agent can read it.
 *
 * Files land under <cwd>/.happy/uploads/ and are referenced by relative path in
 * the message sent to Claude. The .happy/ directory is added to the repo's
 * .git/info/exclude (local, untracked) so uploaded files never pollute git.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from '@/ui/logger';

/** Strip any directory components and reject traversal; basename only. */
export function sanitizeAttachmentName(name: string): string {
    const base = path.basename(name.replace(/\\/g, '/'));
    if (!base || base === '.' || base === '..') return 'file';
    return base;
}

/**
 * Write `data` to <cwd>/.happy/uploads/<uid>-<sanitized name>.
 * Returns the path relative to cwd (e.g. "./.happy/uploads/abcd-report.pdf").
 */
export async function materializeAttachment(
    cwd: string,
    name: string,
    data: Uint8Array,
    uid: string,
): Promise<string> {
    const dir = path.join(cwd, '.happy', 'uploads');
    await fs.mkdir(dir, { recursive: true });
    const filename = `${uid}-${sanitizeAttachmentName(name)}`;
    await fs.writeFile(path.join(dir, filename), data);
    return `./.happy/uploads/${filename}`;
}

/** Idempotently add `.happy/` to .git/info/exclude when cwd is a git repo. */
export async function ensureHappyExcluded(cwd: string): Promise<void> {
    const excludePath = path.join(cwd, '.git', 'info', 'exclude');
    try {
        // Only act inside a git working tree.
        await fs.access(path.join(cwd, '.git'));
    } catch {
        return;
    }
    try {
        let content = '';
        try {
            content = await fs.readFile(excludePath, 'utf8');
        } catch {
            // exclude file may not exist yet — ensure the info dir does.
            await fs.mkdir(path.join(cwd, '.git', 'info'), { recursive: true });
        }
        if (/^\.happy\/$/m.test(content)) return;
        const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
        await fs.appendFile(excludePath, `${prefix}.happy/\n`);
    } catch (err) {
        logger.debug('[materialize] Failed to update .git/info/exclude', { err });
    }
}
