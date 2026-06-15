# Design: General file upload (any file type → Claude)

**Date:** 2026-06-14
**Status:** Approved (brainstorm), pending implementation plan
**Scope:** happy-plus fork — app picker/UI + CLI consumer + server size bump

## Problem

The fork only supports **image** attachments. The picker (`useImagePicker.ts`)
hard-codes `mediaTypes: ['images']`, the preview strip renders thumbnails, and
the CLI consumer (`claudeRemoteLauncher.ts`) feeds attachments to Claude only as
`image` content blocks — **non-image attachments are silently dropped**. Users
want to attach arbitrary files (CSV, PDF, zip, code, …) and have Claude work
with them.

## Key insight

The encrypted blob pipeline is already **file-type-agnostic**:
read bytes → `encryptBlob` → `request-upload` → `ref` → (CLI) `request-download`
→ `decryptBlob`. Nothing in upload/download cares about MIME type. Only three
places are image-specific, plus a server-side size cap.

## Chosen approach

Reuse the existing pipeline. Branch out a **non-image path**:

- **Images** keep current behavior — inlined to Claude as `image` content blocks
  (Claude sees them directly for visual reasoning).
- **Non-image files** are decrypted by the CLI and **materialized to disk** under
  the session working directory at `.happy/uploads/`, and their relative paths
  are appended to the text message sent to Claude. Claude reads them with its own
  tools. This handles **any** file type and fits the coding-agent model.

The image-vs-file decision is made on the **CLI** side by magic-byte detection
(`detectClaudeImageMime`), which already exists. Today: image → inline, else →
skip. Change: else → materialize to disk instead of skip.

### Decisions (locked)

| Decision | Choice |
|---|---|
| Non-image delivery | Materialize to disk + reference path in message |
| Images | Stay inline (unchanged) |
| Disk location | `<session.cwd>/.happy/uploads/` + auto-exclude via `.git/info/exclude` |
| Max file size | 50 MB (server cap raised to 55 MB to cover encryption overhead) |
| Runner scope | Claude only (Codex/Gemini/OpenClaw keep "alert + drop") |
| Allowed types | Any |

## Changes by component

### 1. Server `happy-server` (requires re-release + redeploy)

`sources/app/api/routes/attachmentRoutes.ts`
- `MAX_FILE_SIZE` `10 * 1024 * 1024` → `55 * 1024 * 1024`. This single constant
  governs the zod schema (`size: z.number().max(MAX_FILE_SIZE)`), the explicit
  413 check, the S3 policy `setContentLengthRange`, and the local-mode PUT body
  check — all four update together.
- `bodyLimit` is already 100 MB (`api.ts:45`) — no change.

`sources/app/api/routes/attachmentRoutes.spec.ts`
- Update the two `10 * 1024 * 1024` assertions (`s3PolicyMaxLength` expectation
  and the oversize-rejection payload) to the new cap.

> ⚠️ Without redeploying the server image, 50 MB uploads are rejected with 413 by
> the live 10 MB cap. The app/CLI changes alone are not enough for >10 MB files.

### 2. App picker

`sources/sync/attachmentTypes.ts`
- Add `kind?: 'image' | 'file'` to `AttachmentPreview` (default treated as
  `'image'` for the existing path; document picker sets `'file'`).

`sources/hooks/useDocumentPicker.ts` (new)
- Wrap `expo-document-picker` (`getDocumentAsync({ type: '*/*',
  multiple: true, copyToCacheDirectory: true })`).
- Produce `AttachmentPreview` entries: `kind: 'file'`, `width: 0`, `height: 0`,
  no `thumbhash`, `mimeType` from picker (or `application/octet-stream`),
  `name`/`size`/`uri` from picker.
- Enforce `MAX_FILE_SIZE` (50 MB) and the shared per-message count cap.
- Mirror `useImagePicker`'s `add/remove/clear` shape so it funnels into the same
  `selectedImages` state via `onAddImages`.

`sources/hooks/useImagePicker.ts`
- Bump `MAX_FILE_SIZE` 10 MB → 50 MB (shared constant; export from one place so
  both hooks agree).
- Image entries explicitly set `kind: 'image'`.

### 3. App preview / input UI

`sources/components/AgentInputAttachmentStrip.tsx`
- For `kind === 'file'` (or any non-image), render a **file chip**: file-type
  icon + truncated filename (+ optional size) + remove button, instead of an
  `expo-image` thumbnail. Images render as today.

`sources/components/AgentInput.tsx`
- Add a 📎 attach button next to the existing 📷 image button, gated by the same
  `expImageUpload` feature flag. It calls the document picker; results flow
  through the existing `onAddImages` → `selectedImages` path.

`sources/sync/sync.ts`
- **No change.** The file event already omits the `image` sub-object when
  `width/height === 0` (`sync.ts:631`), so non-image attachments produce a
  bare `{ t: 'file', ref, name, size }` event automatically.

### 4. CLI consumer `claudeRemoteLauncher.ts` (core)

In `nextMessage`, where attachments are turned into content blocks:
- Image (magic-byte match) → `image` content block (unchanged).
- **Non-image → materialize to disk** instead of `continue`/skip:
  1. Compute target dir `path.join(session.path, '.happy', 'uploads')`,
     `mkdir -p`.
  2. Filename = `<short-uid>-<sanitizedBasename(att.name)>` — basename only,
     strip path separators / traversal, fall back to `file` if empty.
  3. Write `att.data` bytes to that path.
  4. Collect the **relative** path `./.happy/uploads/<filename>`.
- After processing all attachments, if any files were written, prepend a note to
  the text:
  `[Attached files: ./.happy/uploads/a.csv, ./.happy/uploads/b.pdf]\n\n` + message.
- git hygiene: once per session (idempotent), if `<cwd>/.git` exists and
  `.git/info/exclude` lacks a `.happy/` line, append `.happy/`. Never touch the
  user's tracked `.gitignore`.

Bytes, MIME, and name are already available on the drained attachment object
(`{ data, mimeType, name }`), and `session.path` is the working directory — no
new plumbing through the queue.

## Out of scope (unchanged)

- File-event wire schema (CLI decides image vs file by magic bytes; disk write
  only needs `att.name`).
- Codex / Gemini / OpenClaw runners — keep current "alert + drop" warning.
- Encryption, `request-upload`/`request-download`,
  `downloadAndDecryptAttachment` — fully reused.

## Risks / notes

- **Server redeploy required** for the 50 MB cap (else 413 at 10 MB).
- **CLI runs stale code** — a new session is required after upgrading the CLI for
  the disk-materialization path to take effect.
- **iOS document-picker URI** may be a cached copy; verify `readFileBytes`
  handles it (it already reads image-picker `file://`/`content://` URIs, so
  likely fine — confirm during implementation).
- Disk usage: materialized files persist in `.happy/uploads/`. Acceptable for
  v1; a cleanup policy can come later if needed.

## Testing

- Server: unit tests for the new size cap (accept 50 MB, reject >55 MB).
- App: type-check; manual pick of a non-image file shows a file chip.
- CLI: unit test for the sanitize-filename + materialize helper (path traversal
  rejected, bytes written, relative path returned); `.git/info/exclude` append
  is idempotent.
- E2E (manual): enable `expImageUpload`, attach a `.csv` to a Claude session,
  confirm it lands in `.happy/uploads/` and Claude can Read it.
