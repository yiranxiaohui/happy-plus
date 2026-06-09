/**
 * Project file listing via git ls-files.
 * Fetches all tracked + untracked files and stores them in Zustand.
 */

import { sessionBash } from './ops';
import { storage } from './storage';

export interface ProjectFile {
    fileName: string;
    filePath: string;
    fullPath: string;
}

export interface ProjectFilesList {
    files: ProjectFile[];
    fetchedAt: number;
    truncated?: boolean;
}

/** Hard cap on listed files — protects the UI from pathological repos. */
export const MAX_PROJECT_FILES = 2000;

/**
 * Fetch project files for a session via `git ls-files` (tracked + untracked,
 * respecting .gitignore). Caps the result at MAX_PROJECT_FILES at the source
 * (so we never transfer/parse a huge list) and reports `truncated` when the cap
 * was hit. Returns null only when the session has no project directory. THROWS
 * on RPC/timeout failure so the caller can retry — a thrown error is distinct
 * from a genuinely empty repo (which returns an empty list).
 */
export async function getProjectFiles(sessionId: string): Promise<ProjectFilesList | null> {
    const session = storage.getState().sessions[sessionId];
    if (!session?.metadata?.path) {
        return null;
    }

    const cwd = session.metadata.path;

    // `| head` caps stdout at the source. Request one extra line to detect truncation.
    // A non-git cwd makes `git ls-files` error, but the pipeline's exit code is
    // head's (0) with empty output -> treated as an empty project, not a failure.
    const res = await sessionBash(sessionId, {
        command: `git ls-files --cached --others --exclude-standard | head -n ${MAX_PROJECT_FILES + 1}`,
        cwd,
        timeout: 15000,
    });

    if (!res.success) {
        throw new Error('Failed to list project files');
    }

    const lines = (res.stdout ?? '')
        .split('\n')
        .filter(p => p.trim().length > 0);
    const truncated = lines.length > MAX_PROJECT_FILES;
    const files: ProjectFile[] = lines.slice(0, MAX_PROJECT_FILES).map(p => {
        const clean = p.startsWith('./') ? p.slice(2) : p;
        const parts = clean.split('/');
        const fileName = parts[parts.length - 1] || clean;
        const filePath = parts.slice(0, -1).join('/');
        return { fileName, filePath, fullPath: clean };
    });

    return { files, fetchedAt: Date.now(), truncated };
}
