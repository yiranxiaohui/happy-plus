# Displaying Claude-Returned Images in Happy — Design

**Date:** 2026-06-10
**Status:** Approved design, pending implementation plan
**Scope:** Make images produced by Claude visible in the Happy app/web — both images inside tool results (e.g. `Read` on an image file, screenshot tools) and image blocks in assistant messages.

---

## 1. Problem & Confirmed Gaps

Users can already SEND images (app uploads an encrypted attachment via the
attachments API, then emits a `file` envelope; the CLI downloads and feeds it
to Claude). The RETURN direction is broken — images coming back from Claude
never reach the user. Confirmed drop points:

1. **CLI `sessionProtocolMapper.ts` (primary gap, both paths):**
   - The assistant-blocks loop handles only `text | thinking | tool_use`; an
     `image` block matches no branch and is **silently dropped** (~line 482).
   - `tool_result` blocks are mapped to a bare `tool-call-end { call }` with
     **no content at all** (~line 583) — any image inside the tool result is
     lost there.
2. **App:** `typesRaw.ts` raw-content schemas have no `image` block type, and
   `MessageView` has no image rendering — but this matters less than expected,
   because the chosen design routes images through the existing `file`
   envelope, which the app **already parses and renders** (`typesRaw.ts:677` →
   tool-call-shaped message with image metadata; `FileView.tsx`).

**Infrastructure that already exists (reused, not built):**
- Wire protocol `file` event: `{ t:'file', ref, name, size, mimeType?, image?:{width,height,thumbhash?} }` (`happy-wire/src/sessionProtocol.ts:47`).
- Server attachments API (zero changes needed): `POST request-upload` →
  `{ ref, uploadUrl }` → `PUT` encrypted blob; symmetric `request-download`.
- CLI already implements attachment **download** (`apiSession.ts`
  `request-download` flow); upload is the missing mirror.
- App-side encrypted attachment upload exists (`apiAttachments.ts`) as the
  reference implementation for the CLI's upload.

## 2. Decision: attachment reference, not inline base64

Two options were considered:

- **A. Attachment reference (CHOSEN):** CLI decodes the image base64, encrypts
  and uploads it as a session attachment, then emits a `file` envelope with
  the `ref`. Reuses the entire existing channel (protocol, storage, app
  rendering); the chat message stream stays light (no multi-MB base64 inside
  encrypted message history); app changes are near zero.
- **B. Inline base64 in a new message type:** rejected — requires changes in
  wire protocol + app schema + rendering, and bloats message bodies
  (encryption, storage, sync all carry the image forever).

## 3. Coverage

Both image sources, one mechanism:
1. **Tool-result images** (most common): `tool_result.content[]` containing
   `{ type:'image', source:{ type:'base64', media_type, data } }` — e.g.
   Claude `Read`s an image file, screenshot tools.
2. **Assistant message image blocks** (rare): `image` blocks directly in
   assistant `message.content[]`.

## 4. Data Flow

```
Claude SDK message (image block)
  │  CLI sessionProtocolMapper: new image branches (assistant blocks +
  │  tool_result content scan)
  ▼
CLI: base64 → Buffer → encrypt → POST request-upload → PUT blob → ref
  │  emit file envelope { t:'file', ref, name, mimeType, size,
  │                       image:{width,height} }
  ▼
server (ZERO changes: attachment routes exist; messages are E2E relay)
  ▼
app (near-zero changes: file envelope already parsed at typesRaw.ts:677,
     rendered by FileView)
```

## 5. CLI Implementation Details

### 5.1 `apiSession.ts` — `uploadAttachment`

New method mirroring the app's `apiAttachments.ts` and the CLI's own
`request-download`:
`uploadAttachment(data: Buffer, mimeType: string, name: string): Promise<{ ref: string; size: number }>`
- `POST /v1/sessions/:id/attachments/request-upload` → `{ ref, uploadUrl }`
  (handle both PUT and S3-presigned-POST shapes like the app does; loopback
  host rewrite if applicable).
- Encrypt with the session encryption (same primitives as download path).
- `PUT`/`POST` the encrypted blob to `uploadUrl`.

### 5.2 `sessionProtocolMapper.ts` — image branches + pending-upload queue

The mapper is a synchronous pure function; uploads are async. The mapper does
NOT upload. Instead:
- New image branches (assistant loop; tool_result content scan) collect
  `{ base64, mediaType, placementIndex }` into a **pendingImages** list
  returned alongside the envelopes (extend the mapper's return type).
- `sendClaudeSessionMessage` (already async context in `apiSession.ts`)
  consumes pendingImages: for each, decode → size-check → upload → emit a
  `file` envelope. Emission order: after the envelopes of the message that
  contained the image (acceptable MVP ordering; images appear right after
  their message).
- tool_result mapping otherwise unchanged (still emits `tool-call-end`).

### 5.3 Image dimensions

Parse width/height from PNG (IHDR) / JPEG (SOFn) headers with a small local
pure function — no new heavy dependency. On parse failure, omit the `image`
field from the envelope (app renders the file generically).

### 5.4 Limits & failure handling

- Max image size: **10MB** decoded. Oversized → skip upload, emit a `text`
  envelope placeholder `[image: too large to display]`.
- Upload failure (network/server error) → emit `text` envelope
  `[image: upload failed]`; never block or fail the message flow.
- Placeholders are plain CLI-emitted text — no app i18n keys needed.

## 6. App-Side (verification + possible micro-tweaks)

The `file` envelope path was built for USER-sent images (user role); agent
images arrive with the agent role. Verify and, only if needed, micro-adjust:
1. Reducer: agent-role file messages land in the renderable path (the
   envelope is converted to a tool-call-shaped message — likely role-agnostic).
2. `FileView` downloads via session-scoped `request-download` — same session,
   should work as-is.
No new components. If a tweak is needed it is confined to reducer/FileView
role handling.

## 7. Testing

- **CLI unit (primary):**
  - mapper: assistant image block → pendingImages entry; tool_result image →
    pendingImages entry; ordering/placeholders correct; non-image paths
    regress nothing.
  - `uploadAttachment`: mocked fetch — request-upload→PUT flow, encryption
    called, errors propagate.
  - dimension parser: PNG/JPEG fixtures → correct width/height; garbage →
    null.
  - size cap: >10MB → placeholder text, no upload attempted.
- **App unit:** only if reducer is tweaked (agent file envelope → message).
- **Manual E2E:** in a real session, ask Claude to `Read` an image file →
  image visible in app/web; screenshot-tool scenario likewise.

## 8. Release & Compatibility

- Ships as a normal unified `vX.Y.Z` release (CLI npm + server image whose
  bundled web is rebuilt) + compose deploy. Server code itself: zero changes.
- Machines must upgrade their CLI to start sending images back; old CLIs
  simply keep dropping images (current behavior) — no compatibility break in
  either direction. Old apps receiving the new `file` envelopes already parse
  them (the type predates this feature).

## 9. Non-Goals

- Inline base64 transport (rejected, §2).
- Image thumbnailing/thumbhash generation on the CLI (envelope's `thumbhash`
  stays unset; app handles absence today).
- Video or non-image binary tool outputs.
- Server-side changes of any kind.
