# General File Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users attach any file type (CSV, PDF, zip, code, …) to a Claude session; non-image files are materialized to disk in the session's working dir and referenced by path, images stay inline.

**Architecture:** Reuse the existing type-agnostic encrypted blob pipeline. The App gains a document picker that funnels into the same `selectedImages` state. The CLI consumer, which already branches image-vs-other by magic bytes, writes non-image attachments to `<cwd>/.happy/uploads/` and appends their relative paths to the message text instead of dropping them. The server's 10 MB cap is raised to cover 50 MB uploads.

**Tech Stack:** TypeScript, React Native / Expo (`expo-document-picker`), Fastify + Zod (server), Vitest (server & CLI tests), Anthropic SDK content blocks (CLI).

---

## File Structure

**Server (`packages/happy-server`)**
- Modify: `sources/app/api/routes/attachmentRoutes.ts` — raise `MAX_FILE_SIZE`.
- Modify: `sources/app/api/routes/attachmentRoutes.spec.ts` — update size assertions.

**App (`packages/happy-app`)**
- Modify: `sources/sync/attachmentTypes.ts` — add `kind` field.
- Modify: `sources/hooks/useImagePicker.ts` — bump size cap, set `kind: 'image'`.
- Create: `sources/hooks/useDocumentPicker.ts` — stateless any-file picker.
- Modify: `sources/components/AgentInputAttachmentStrip.tsx` — file-chip rendering.
- Modify: `sources/components/AgentInput.tsx` — add 📎 button + `onPickFiles` prop.
- Modify: `sources/-session/SessionView.tsx` — wire document picker into `addImages`.

**CLI (`packages/happy-cli`)**
- Create: `src/claude/utils/materializeAttachment.ts` — sanitize + write + git-exclude helpers.
- Create: `src/claude/utils/materializeAttachment.spec.ts` — unit tests.
- Modify: `src/claude/claudeRemoteLauncher.ts` — materialize non-image attachments.

No new i18n keys: the document picker reuses existing `imageUpload.*` alert strings; the file chip displays the raw filename.

---

## Task 1: Server — raise attachment size cap to 55 MB

**Files:**
- Modify: `packages/happy-server/sources/app/api/routes/attachmentRoutes.ts:19`
- Modify: `packages/happy-server/sources/app/api/routes/attachmentRoutes.spec.ts:168,204`

- [ ] **Step 1: Update the spec assertions to the new cap (failing test first)**

In `attachmentRoutes.spec.ts`, change line 168:
```typescript
        expect(state.s3PolicyMaxLength).toBe(55 * 1024 * 1024);
```
and line 204:
```typescript
            payload: { filename: "huge.bin", size: 55 * 1024 * 1024 + 1 },
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `cd packages/happy-server && pnpm vitest run sources/app/api/routes/attachmentRoutes.spec.ts`
Expected: FAIL — `s3PolicyMaxLength` still 10 MB; the oversize-rejection test now sends 55 MB+1 but the route accepts up to... it still rejects (>10MB) so that one may pass, but the `s3PolicyMaxLength` assertion fails. At least one failure.

- [ ] **Step 3: Raise the constant**

In `attachmentRoutes.ts`, change line 19:
```typescript
const MAX_FILE_SIZE = 55 * 1024 * 1024; // 55MB (50MB raw + encryption overhead headroom)
```

- [ ] **Step 4: Run the spec to verify it passes**

Run: `cd packages/happy-server && pnpm vitest run sources/app/api/routes/attachmentRoutes.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/happy-server/sources/app/api/routes/attachmentRoutes.ts packages/happy-server/sources/app/api/routes/attachmentRoutes.spec.ts
git commit -m "feat(server): raise attachment size cap 10MB -> 55MB for general file upload"
```

---

## Task 2: App — add `kind` to AttachmentPreview + bump image picker cap

**Files:**
- Modify: `packages/happy-app/sources/sync/attachmentTypes.ts:7-18`
- Modify: `packages/happy-app/sources/hooks/useImagePicker.ts:21,101-110`

- [ ] **Step 1: Add the `kind` field to the type**

In `attachmentTypes.ts`, add to the `AttachmentPreview` type (after `name`):
```typescript
export type AttachmentPreview = {
    /** Stable unique identifier for use as React key and for removal. */
    id: string;
    /** 'image' renders as a thumbnail and inlines to Claude; 'file' renders as a chip and is materialized to disk by the CLI. Absent = 'image' for backward compat. */
    kind?: 'image' | 'file';
    uri: string;
    width: number;
    height: number;
    mimeType: string;
    /** May be 0 if the system did not provide the file size. */
    size: number;
    name: string;
    thumbhash?: string;
};
```

- [ ] **Step 2: Bump the size cap and tag image entries**

In `useImagePicker.ts` line 21:
```typescript
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
```
In the `previews.push({ ... })` block (around line 101), add `kind: 'image'`:
```typescript
            previews.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
                kind: 'image',
                uri: asset.uri,
                width: asset.width,
                height: asset.height,
                mimeType: asset.mimeType ?? 'image/jpeg',
                size,
                name: asset.fileName ?? `image_${Date.now()}.jpg`,
                thumbhash,
            });
```

- [ ] **Step 3: Type-check**

Run: `cd packages/happy-app && pnpm typecheck`
Expected: PASS (no type errors)

- [ ] **Step 4: Commit**

```bash
git add packages/happy-app/sources/sync/attachmentTypes.ts packages/happy-app/sources/hooks/useImagePicker.ts
git commit -m "feat(app): add AttachmentPreview.kind + raise image cap to 50MB"
```

---

## Task 3: App — `useDocumentPicker` hook

**Files:**
- Create: `packages/happy-app/sources/hooks/useDocumentPicker.ts`

- [ ] **Step 1: Create the hook**

Create `useDocumentPicker.ts`:
```typescript
/**
 * Any-file picker for message attachments. Stateless: returns picked files as
 * AttachmentPreview entries (kind: 'file') for the caller to funnel into the
 * shared selected-attachments state via useImagePicker's addImages().
 *
 * Files are non-images: width/height are 0 and no thumbhash, so the file event
 * built in sync.ts omits the `image` sub-object automatically. The CLI then
 * materializes them to disk instead of inlining.
 */
import { useCallback } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import { Modal } from '@/modal';
import { t } from '@/text';
import { MAX_FILE_SIZE } from './useImagePicker';
import type { AttachmentPreview } from '@/sync/attachmentTypes';

type UseDocumentPickerResult = {
    pickDocuments: () => Promise<AttachmentPreview[]>;
};

export function useDocumentPicker(): UseDocumentPickerResult {
    const pickDocuments = useCallback(async (): Promise<AttachmentPreview[]> => {
        const result = await DocumentPicker.getDocumentAsync({
            type: '*/*',
            multiple: true,
            copyToCacheDirectory: true, // gives a readable file:// URI for readFileBytes
        });

        if (result.canceled || !result.assets?.length) return [];

        const previews: AttachmentPreview[] = [];
        for (const asset of result.assets) {
            const size = asset.size ?? 0;
            if (size > MAX_FILE_SIZE) {
                Modal.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name: asset.name ?? 'file', maxMb: 50 }),
                    [{ text: t('common.ok') }],
                );
                continue;
            }
            previews.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
                kind: 'file',
                uri: asset.uri,
                width: 0,
                height: 0,
                mimeType: asset.mimeType ?? 'application/octet-stream',
                size,
                name: asset.name ?? `file_${Date.now()}`,
            });
        }
        return previews;
    }, []);

    return { pickDocuments };
}
```

- [ ] **Step 2: Type-check**

Run: `cd packages/happy-app && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/happy-app/sources/hooks/useDocumentPicker.ts
git commit -m "feat(app): add useDocumentPicker for any-file attachments"
```

---

## Task 4: App — file-chip rendering in the attachment strip

**Files:**
- Modify: `packages/happy-app/sources/components/AgentInputAttachmentStrip.tsx`

- [ ] **Step 1: Branch the per-item renderer on kind**

Replace the `images.map(...)` body so non-image items render a chip. In the `AgentInputAttachmentStrip` component, change the map:
```typescript
            {images.map((img) => (
                img.kind === 'file' ? (
                    <AttachmentFileChip
                        key={img.id}
                        file={img}
                        onRemove={onRemove}
                        theme={theme}
                    />
                ) : (
                    <AttachmentThumbnail
                        key={img.id}
                        image={img}
                        onRemove={onRemove}
                        theme={theme}
                    />
                )
            ))}
```

- [ ] **Step 2: Add the file-chip component**

Add after the `AttachmentThumbnail` function (before the `styles` block). Import `Text` from `react-native` (add to the existing `react-native` import line: `import { ScrollView, View, Pressable, Text } from 'react-native';`):
```typescript
function AttachmentFileChip({
    file,
    onRemove,
    theme,
}: {
    file: AttachmentPreview;
    onRemove: (id: string) => void;
    theme: any;
}) {
    return (
        <View style={[styles.chipContainer, { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }]}>
            <Ionicons name="document-outline" size={20} color={theme.colors.text} />
            <Text numberOfLines={1} style={[styles.chipName, { color: theme.colors.text }]}>
                {file.name}
            </Text>
            <Pressable
                onPress={() => onRemove(file.id)}
                hitSlop={4}
                style={(p) => [
                    styles.removeButton,
                    { backgroundColor: theme.colors.surfaceHigh, opacity: p.pressed ? 0.7 : 1 },
                ]}
            >
                <Ionicons name="close" size={10} color={theme.colors.text} />
            </Pressable>
        </View>
    );
}
```

- [ ] **Step 3: Add chip styles**

In the `styles` `StyleSheet.create(() => ({ ... }))` object, add:
```typescript
    chipContainer: {
        height: THUMB_SIZE,
        maxWidth: 180,
        borderRadius: BORDER_RADIUS,
        borderWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        position: 'relative',
    },
    chipName: {
        fontSize: 13,
        flexShrink: 1,
    },
```

- [ ] **Step 4: Type-check**

Run: `cd packages/happy-app && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/happy-app/sources/components/AgentInputAttachmentStrip.tsx
git commit -m "feat(app): render non-image attachments as file chips"
```

---

## Task 5: App — 📎 button in AgentInput + SessionView wiring

**Files:**
- Modify: `packages/happy-app/sources/components/AgentInput.tsx:91-93,1329-1353`
- Modify: `packages/happy-app/sources/-session/SessionView.tsx:19,480,680-683`

- [ ] **Step 1: Add the `onPickFiles` prop**

In `AgentInput.tsx`, near the existing `onPickImages?: () => void;` (line 91), add:
```typescript
    onPickImages?: () => void;
    /** Open the any-file document picker (expImageUpload feature). */
    onPickFiles?: () => void;
```

- [ ] **Step 2: Add the 📎 button after the image picker button**

In `AgentInput.tsx`, immediately after the image picker `Pressable` block that ends at line 1353 (`)}` closing `{props.onPickImages && (`), add:
```typescript
                                {/* Document picker button (expImageUpload) */}
                                {props.onPickFiles && (
                                    <Pressable
                                        onPress={props.onPickFiles}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 8,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            height: 32,
                                            opacity: p.pressed ? 0.7 : 1,
                                        })}
                                    >
                                        <Ionicons
                                            name="attach-outline"
                                            size={18}
                                            color={theme.colors.button.secondary.tint}
                                        />
                                    </Pressable>
                                )}
```

- [ ] **Step 3: Wire the document picker in SessionView**

In `SessionView.tsx` line 19, add the import after the `useImagePicker` import:
```typescript
import { useImagePicker } from '@/hooks/useImagePicker';
import { useDocumentPicker } from '@/hooks/useDocumentPicker';
```
At line 480 (after the `useImagePicker()` destructure), add:
```typescript
    const { selectedImages, pickImages, removeImage, clearImages, addImages } = useImagePicker();
    const { pickDocuments } = useDocumentPicker();
```
In the `AgentInput` JSX props (after `onPickImages={...}` at line 681), add:
```typescript
            onPickImages={expImageUpload ? pickImages : undefined}
            onPickFiles={expImageUpload ? (() => { pickDocuments().then(addImages); }) : undefined}
```

- [ ] **Step 4: Type-check**

Run: `cd packages/happy-app && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/happy-app/sources/components/AgentInput.tsx packages/happy-app/sources/-session/SessionView.tsx
git commit -m "feat(app): add document-picker button wired into attachment flow"
```

---

## Task 6: CLI — materialize helper (pure + fs) with unit tests

**Files:**
- Create: `packages/happy-cli/src/claude/utils/materializeAttachment.ts`
- Create: `packages/happy-cli/src/claude/utils/materializeAttachment.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `materializeAttachment.spec.ts`:
```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/happy-cli && pnpm vitest run --project unit src/claude/utils/materializeAttachment.spec.ts`
Expected: FAIL — module `./materializeAttachment` not found.

- [ ] **Step 3: Implement the helper**

Create `materializeAttachment.ts`:
```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/happy-cli && pnpm vitest run --project unit src/claude/utils/materializeAttachment.spec.ts`
Expected: PASS (all 7 assertions across the describe blocks)

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/claude/utils/materializeAttachment.ts packages/happy-cli/src/claude/utils/materializeAttachment.spec.ts
git commit -m "feat(cli): add attachment materialization helper (sanitize + write + git-exclude)"
```

---

## Task 7: CLI — materialize non-image attachments in claudeRemoteLauncher

**Files:**
- Modify: `packages/happy-cli/src/claude/claudeRemoteLauncher.ts:1-19,347-378`

- [ ] **Step 1: Add imports**

In `claudeRemoteLauncher.ts`, after the existing import block (after line 19 `import type { MessageParam, ContentBlockParam } ...`), add:
```typescript
import { randomUUID } from 'crypto';
import { materializeAttachment, ensureHappyExcluded } from './utils/materializeAttachment';
```

- [ ] **Step 2: Replace the attachment loop to materialize non-images**

In the `nextMessage` handler, replace the existing `if (attachments.length > 0) { ... }` block (lines ~348-378, the one that builds `contentBlocks`) with:
```typescript
                            const attachments = msg.attachments ?? [];
                            if (attachments.length > 0) {
                                const contentBlocks: ContentBlockParam[] = [];
                                const filePaths: string[] = [];
                                for (const att of attachments) {
                                    // Images Claude can view go inline as image blocks.
                                    const detected = detectClaudeImageMime(att.data);
                                    if (detected) {
                                        contentBlocks.push({
                                            type: 'image' as const,
                                            source: {
                                                type: 'base64' as const,
                                                media_type: detected,
                                                data: Buffer.from(att.data).toString('base64'),
                                            },
                                        });
                                        continue;
                                    }
                                    // Everything else is written to disk and referenced by path.
                                    try {
                                        await ensureHappyExcluded(session.path);
                                        const rel = await materializeAttachment(
                                            session.path,
                                            att.name,
                                            att.data,
                                            randomUUID().slice(0, 8),
                                        );
                                        filePaths.push(rel);
                                        logger.debug(`[remote] Materialized attachment to ${rel}`);
                                    } catch (err) {
                                        logger.debug(`[remote] Failed to materialize attachment ${att.name}`, { err });
                                    }
                                }
                                const note = filePaths.length > 0
                                    ? `[Attached files: ${filePaths.join(', ')}]\n\n`
                                    : '';
                                contentBlocks.push({ type: 'text' as const, text: note + msg.message });
                                logger.debug(`[remote] ${contentBlocks.length - 1} inline block(s), ${filePaths.length} file(s) on disk`);
                                return {
                                    message: contentBlocks,
                                    mode: msg.mode,
                                };
                            }
```

- [ ] **Step 3: Build the CLI to verify it compiles**

Run: `cd packages/happy-cli && pnpm run build`
Expected: build succeeds, no TypeScript errors.

- [ ] **Step 4: Run the full CLI unit suite**

Run: `cd packages/happy-cli && pnpm vitest run --project unit`
Expected: PASS (including the new materialize tests and existing `agentImageFlow`/`uploadAttachment` tests).

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/claude/claudeRemoteLauncher.ts
git commit -m "feat(cli): materialize non-image attachments to .happy/uploads and reference by path"
```

---

## Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: App type-check**

Run: `cd packages/happy-app && pnpm typecheck`
Expected: PASS

- [ ] **Step 2: CLI type-check + build**

Run: `cd packages/happy-cli && pnpm run build`
Expected: PASS

- [ ] **Step 3: Server tests**

Run: `cd packages/happy-server && pnpm vitest run sources/app/api/routes/attachmentRoutes.spec.ts`
Expected: PASS

- [ ] **Step 4: Manual E2E checklist (document for the user, do not automate)**

Record these as the acceptance steps to run after a release+deploy:
1. Deploy the new server image (55 MB cap) — required for >10 MB files.
2. Install/run the new CLI; start a **fresh** Claude session (stale processes run old code).
3. In the app, Settings → Features → enable **Image Upload**.
4. Tap 📎, pick a `.csv` (or any non-image), send a message.
5. Confirm the file appears as a chip before send, and after send it exists at
   `<session cwd>/.happy/uploads/<uid>-<name>.csv`, that `.happy/` is in
   `.git/info/exclude`, and Claude can `Read` the path from the message note.

- [ ] **Step 5: Commit any doc note (if the checklist was added to a doc)**

```bash
# Only if a checklist note file was created/updated:
git add -A && git commit -m "docs: file-upload manual E2E checklist"
```

---

## Deployment note (post-implementation)

Per `.claude/CLAUDE.md`: ship via a unified `vX.Y.Z` tag (CLI→npm `happy-plus`, APK, server image→GHCR). The **server change (Task 1) only takes effect after the new server image is deployed** to `10.0.12.1` via the SSH+compose flow. Until then the live 10 MB cap rejects >10 MB uploads with 413.
