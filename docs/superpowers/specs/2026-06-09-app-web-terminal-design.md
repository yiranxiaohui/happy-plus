# Interactive Terminal for Happy app & web — Design

**Date:** 2026-06-09
**Status:** Approved design, pending implementation plan
**Scope:** Add a full interactive terminal (PTY) to the Happy app (iOS/Android) and web clients, letting a user open a shell on a registered machine and type commands — including interactive programs (vim, top), colors, Ctrl-C, tab completion, and live streaming output.

---

## 1. Goals & Decisions

Locked-in product decisions (from brainstorming):

1. **Full interactive PTY** — equivalent to an SSH terminal: vim/top, ANSI colors, Ctrl-C, tab completion, real-time streaming. Implemented with `node-pty` (CLI) + `xterm.js` (clients).
2. **Two entry points** — machine-level terminal (from the machine list/detail screen) and session-level terminal (from the session screen, starting in that session's working directory). Both use the **same** underlying PTY-over-RPC mechanism; the session terminal merely passes the session's `cwd`.
3. **Persistent + reconnect (tmux-like)** — the PTY lives on the machine via the daemon and survives app disconnect/backgrounding. On reconnect the client re-attaches to the same terminal and replays a scrollback buffer.
4. **Unified xterm.js rendering** — web renders xterm.js directly into the DOM; native wraps a bundled xterm.js HTML in `react-native-webview`, bridged via `postMessage`. One terminal implementation across all platforms.

### Non-goals (MVP)

- Surviving daemon restart / machine reboot (terminals die with the daemon — acceptable for MVP, documented).
- Per-terminal derived encryption keys (reuse the machine key for MVP).
- Native (non-webview) terminal renderer.
- File transfer / SFTP-style features.

---

## 2. Architecture

Reuses Happy's existing three-leg link (`daemon ↔ server ↔ app`) and adds a dedicated terminal data channel.

```
┌─────────────┐   xterm.js     ┌───────────────┐   socket.io      ┌────────────────────┐
│  app / web  │◄──input/output─►│  happy-server  │◄──encrypted relay►│  happy-cli daemon   │
│  <Terminal> │                │  terminal route│                  │  + node-pty         │
└─────────────┘                └───────────────┘                  └────────────────────┘
  Web: xterm.js directly          forwards only,                     real shell process,
  Native: webview + xterm.js      never stores/decrypts              maintains PTY + scrollback
```

**Responsibilities:**

- **daemon (CLI):** new terminal manager. `node-pty` spawns a real shell; each terminal holds `{ id, pty, scrollback ring buffer, rows/cols, cwd, title, seq, lastActivity }` and persists across client disconnects.
- **server:** new terminal event routing — relays encrypted data blocks between a specific app connection and a specific machine daemon. **No persistence, no decryption** (pure E2E relay).
- **app:** shared `<Terminal>` component. Web renders xterm.js directly; native embeds xterm.js in `react-native-webview`, bridged with `postMessage` for input/output/resize.

### 2.1 Dual transport channel (key decision)

The existing RPC mechanism (`${machineId}:method`) is **request/response with a 30 s timeout** — good for one-shot operations, wrong for per-keystroke streaming. We therefore split by operation class:

| Operation | Channel | Rationale |
|---|---|---|
| create / attach (fetch scrollback) / close / list | existing **RPC** | one-shot request-response |
| keyboard input / PTY output / resize | new **ephemeral events** (like existing `activity`) | low-latency bidirectional stream, no timeout |

This reuses the mature RPC path for lifecycle and a lightweight event stream for high-frequency I/O, so streaming is never interrupted by the RPC timeout.

---

## 3. Component Interfaces

### 3.1 Encryption

Reuse the **machine's encryption key** (the app already decrypts `daemonState`, so it holds this key). All terminal payloads (`data` fields) are E2E-encrypted with it via the existing `encrypt(data, key, variant)` / `decrypt(...)` from `happy-cli/src/api/encryption.ts` (and the app's mirror). The server only ever relays ciphertext. (Future: per-terminal derived subkey; out of scope for MVP.)

### 3.2 RPC methods (daemon-registered, `${machineId}:` prefix, one-shot)

| Method | Params | Returns |
|---|---|---|
| `terminal-create` | `{ cols, rows, cwd?, shell? }` | `{ terminalId }` |
| `terminal-attach` | `{ terminalId }` | `{ scrollback(enc), cols, rows, alive }` |
| `terminal-list` | `{}` | `{ terminals: [{ id, title, cwd, rows, cols, createdAt }] }` |
| `terminal-close` | `{ terminalId }` | `{ ok }` |

### 3.3 Ephemeral events (low-latency stream, bidirectional)

```
app    → daemon:  terminal-input   { machineId, terminalId, data(enc) }    // keystrokes
app    → daemon:  terminal-resize  { machineId, terminalId, cols, rows }
daemon → app:     terminal-output  { machineId, terminalId, data(enc), seq } // PTY output
daemon → app:     terminal-exit    { machineId, terminalId, exitCode }      // shell exited
```

**Server routing:** `terminal-input`/`terminal-resize` are relayed to the target machine (reuse `machine-scoped-only; machineId`). `terminal-output`/`terminal-exit` are relayed to the user's app connections (`user-scoped`); the client filters by `terminalId`. The server forwards ciphertext only and stores nothing.

### 3.4 daemon TerminalSession

```
{ id, pty (node-pty), scrollback (ring buffer ~256KB), rows, cols, cwd, title, seq, lastActivity }
```

- Persists across client disconnects. `seq` is monotonically increasing so the client can detect dropped blocks (→ trigger re-attach).
- **Cleanup** only when: ① the shell exits (emit `terminal-exit`, destroy), ② the user explicitly closes, ③ the daemon restarts (all terminals cleared). Concurrent cap ~20/machine to prevent leaks. Optional idle timeout, **default off** (tmux-like persistence).

### 3.5 Dependency note: node-pty is a native module

The CLI ships via npm (`happy-plus`, tsx runtime). `node-pty` needs a prebuilt binary or on-site node-gyp build on the user's machine. Mainstream platforms have prebuilts, but this is a **packaging/install-time risk** — consider `@homebridge/node-pty-prebuilt-multiarch` (multi-arch prebuilds). CI must smoke-test that node-pty loads on target platforms.

---

## 4. App-side UI

### 4.1 Shared `<Terminal>` component (platform split, identical outer interface)

- **Web** (`Platform.OS === 'web'`): mount `@xterm/xterm` into a DOM container with `fit` (auto-size), `web-links` (clickable links), and a webgl/canvas renderer addon.
- **Native:** `react-native-webview` loads a **static HTML asset bundled with the app** (xterm.js + addons inlined), bridged via `postMessage`.

Bridge protocol (same shape on both platforms, so outer logic is platform-agnostic):

```
→ terminal:  {write,data} {fit} {focus} {clear}
← terminal:  {input,data}  {resize,cols,rows}
```

### 4.2 `useTerminal(machineId, { terminalId? | cwd? })` hook

Wires the component to the data channel: `terminal-create`/`attach` (RPC) → subscribe to `terminal-output` events → decrypt + write to xterm; user input → encrypt + emit `terminal-input`; resize → `terminal-resize`; on `seq` gap, auto re-attach and replay scrollback. Errors auto-retry (in the spirit of `useHappyAction`).

### 4.3 Entry points

1. **Machine screen** (`machine/[id].tsx`): "Open Terminal" button + a list of existing terminals (`terminal-list`, resumable).
2. **Session screen:** a "Terminal" entry; `terminal-create` with `cwd` = the session's working directory.

Both route to a new screen `(app)/terminal/[machineId]` with a **tab bar supporting multiple concurrent terminals** (one tab per `terminalId`).

### 4.4 Mobile-specific UX (essential for a usable PTY)

- **Accessory key bar:** mobile keyboards lack `Esc / Tab / Ctrl / arrows / Ctrl-C` — add a row of tappable special keys above the terminal. This is the prerequisite for vim/top/interrupting processes.
- Rotation / keyboard show → trigger `fit` to recompute size and emit `resize`.
- Monospace font; theme follows app light/dark.
- Return to foreground / socket reconnect → auto re-attach + replay scrollback, with a subtle "reconnected" indicator.

### 4.5 Static asset

The xterm HTML used by the native webview is a prebuilt asset bundled with the app (an inlined HTML file produced by a build step).

---

## 5. Lifecycle, Security, Testing

### 5.1 Lifecycle details

- **Create:** daemon spawns node-pty with the user's `$SHELL` (login shell), inherited env, `cwd` = session dir or `$HOME`, initial cols/rows.
- **Scrollback:** per-terminal ring buffer, cap ~256KB (configurable), replayed on attach.
- **Destroy** only on: ① shell exit ② explicit close ③ daemon restart (machine reboot / CLI upgrade clears all terminals — weaker than tmux across reboots; accepted for MVP, documented). Concurrent cap ~20/machine; optional idle timeout default off.
- **Reconnect:** re-attach by `terminalId`; if the id no longer exists (daemon restarted), the app shows "terminal ended" and offers to open a new one.
- **Flow control:** for high-output commands (`cat bigfile`, `yes`), the daemon **coalesces output in ~16 ms batches and caps block size** before sending, to avoid flooding the socket.

### 5.2 Security model

- **No widening of the trust boundary:** a full shell = complete control of the machine as the daemon's user, but this matches the account's **existing** capability (it can already run arbitrary bash via Claude sessions and the existing `bash` RPC). The terminal is just a new use of the same **account-authenticated + E2E-encrypted** channel.
- The server enforces machine ownership for the current user (reuse existing machine ownership checks) and only ever sees ciphertext.
- **Optional toggle:** a per-machine / global "allow terminal" setting so security-conscious users can disable it (default on).
- Terminal contents are **never logged** (sensitive).

### 5.3 Testing strategy

- **daemon unit:** terminal manager create/write/resize/close, scrollback truncation, `seq` increment, exit handling, concurrent cap (use an echo-shell stub).
- **server unit:** event routing (input→machine / output→user), ownership enforcement, no persistence.
- **app unit:** `useTerminal` hook (mock channel), bridge protocol both directions, `<Terminal>` render smoke.
- **integration/manual:** open terminal and run vim/top, Ctrl-C, resize, background→reconnect replay, multiple tabs.
- **CI:** smoke-test that node-pty loads on target platforms.

---

## 6. Key file touch-points (from codebase survey)

- **CLI:** new `happy-cli/src/daemon/terminal/` (terminal manager); register RPC + ephemeral handlers near `happy-cli/src/api/rpc/RpcHandlerManager.ts` and the daemon socket setup in `happy-cli/src/daemon/run.ts`; reuse `happy-cli/src/api/encryption.ts`.
- **server:** terminal event routing alongside `happy-server/sources/app/api/socket.ts` / `socket/rpcHandler.ts` and `happy-server/sources/app/events/eventRouter.ts` (add terminal relay; reuse `machine-scoped-only` / `user-scoped` filters).
- **app:** new `<Terminal>` component + `useTerminal` hook under `happy-app/sources/`; new route `(app)/terminal/[machineId]`; entry buttons in `happy-app/sources/app/(app)/machine/[id].tsx` and the session screen; socket wiring in `happy-app/sources/sync/apiSocket.ts`.

---

## 7. Open risks

1. **node-pty packaging** across user platforms (mitigation: multi-arch prebuilt fork + CI smoke).
2. **Native webview input/keyboard bridging** fidelity (IME, special keys) — needs hands-on tuning.
3. **Throughput** of encrypted per-block relay under heavy output (mitigation: daemon-side coalescing; monitor).
