# happy-cli — the component ai-or-die emulates

Read-only source study of `packages/happy-cli` in the Happy monorepo clone at
`C:\Users\anikundu\AppData\Local\Temp\happy-study`, HEAD `d2ef88d`. Every claim
cites `packages/happy-cli/src/...:<line>` (or `packages/happy-wire/src/...` for the
shared wire schemas). This is the adapter blueprint: happy-cli is the "producer"
that pairs, registers a machine, creates sessions, streams Claude output up
(encrypted), and receives input + permission responses down. ai-or-die would
emulate exactly this behaviour on the wire.

> **Doc note:** the repo docs the brief referenced (`docs/cli-architecture.md`,
> `docs/multi-process.md`, `docs/permission-resolution.md`, `docs/user-identity.md`)
> **do not exist at this HEAD** — `packages/happy-cli/docs/` contains only
> `bug-fix-plan-2025-01-15-athundt.md`. This study is therefore sourced entirely
> from code.

> **Two important corrections vs. the brief's assumptions**
> 1. **No hand-rolled `control_request`/`control_response`/`control_cancel_request`
>    protocol exists in this version.** happy-cli drives Claude through the
>    official `@anthropic-ai/claude-agent-sdk` `query()` (`sdk/query.ts:6,80`).
>    The stream-json control channel is *inside* the SDK and is opaque to
>    happy-cli. Permission gating is the SDK's `canUseTool` callback
>    (`sdk/query.ts:73-78`), surfaced to happy-cli as `canCallTool`. An older
>    happy-cli spawned `claude --output-format stream-json` and spoke the control
>    protocol by hand; that is gone here.
> 2. **Messages are NOT emitted over the socket.** New messages are **HTTP
>    `POST /v3/sessions/:id/messages`** batches (`apiSession.ts:655`), and inbound
>    messages are read by **HTTP `GET /v3/sessions/:id/messages`**
>    (`apiSession.ts:591`); the socket `update` event is only a *notification* that
>    triggers a fetch or carries a single already-decryptable message
>    (`apiSession.ts:304-360`). Only metadata/agentState CAS and liveness go over
>    the socket.

---

## Claude wrapping (local/remote, control channel, session-id)

### Local vs remote mode

happy-cli runs one Claude conversation in one of two modes; the mode can switch
mid-session (`runClaude.ts:928-935`, `sendSessionEvent({type:'switch',mode})`).

**Local mode** (`claude/claudeLocal.ts`) — spawns the *real* `claude` CLI so the
user sees Claude Code's own interactive TUI in their terminal. It spawns a
launcher shim `scripts/claude_local_launcher.cjs` via `cross-spawn` with
`stdio: ['inherit','inherit','inherit','pipe']` (`claudeLocal.ts:31,313-320`), so
Claude owns the TTY. happy-cli does **not** parse Claude's stdout for content in
local mode; it only tails the on-disk JSONL transcript (via `sessionScanner`) to
mirror the conversation up to the app. Argv is assembled at
`claudeLocal.ts:210-251`:

```
node <claude_local_launcher.cjs> \
  [--resume <startFrom>]  (or --session-id <uuid> in offline mode) \
  --append-system-prompt <happy systemPrompt> \
  [--mcp-config '{"mcpServers":{...}}'] \
  [--allowedTools a,b,c] \
  ...<user claudeArgs> \
  --settings <hookSettingsPath>          # SessionStart hook for session-id
```

**Remote mode** (`claude/claudeRemote.ts`) — the app is the sole driver; no TTY.
This path calls the SDK `query()` (`claudeRemote.ts:164-167`), feeding user
prompts through a `PushableAsyncIterable<SDKUserMessage>` (`claudeRemote.ts:153-161`)
and receiving `SDKMessage`s back via `for await`. **There is no `claude` argv in
remote mode** — the SDK spawns Claude Code itself. The options happy-cli sets are
mapped 1:1 in `sdk/query.ts:31-47`:

```ts
// sdk/query.ts:31
const sdkOptions: Options = {
    cwd, resume, continue, model, fallbackModel, maxTurns,
    permissionMode, allowedTools, disallowedTools, mcpServers,
    systemPrompt, settings: opts.settingsPath, strictMcpConfig,
    sessionId: undefined, effort,
}
```

Key env tweak (`sdk/query.ts:62-70`): happy sets
`CLAUDE_CODE_ENTRYPOINT` to a Happy-specific value (not one of the SDK's
`{sdk-cli,sdk-ts,sdk-py}`) so Happy-started sessions stay visible in a plain
`claude --resume` picker. `settings: opts.settingsPath` passes the same
SessionStart-hook settings file used in local mode (`claudeRemote.ts:137`).

### The control channel (permission gating)

There is no bespoke JSON control protocol. The SDK's `canUseTool` callback is the
control point (`sdk/query.ts:73-78`):

```ts
// sdk/query.ts:75
sdkOptions.canUseTool = async (toolName, input, options) => {
    return callback(toolName, input, options)   // options.toolUseID, options.signal
}
```

happy-cli's `PermissionHandler.handleToolCall` (`claude/utils/permissionHandler.ts:132`)
is that callback. It returns `{behavior:'allow', updatedInput}` or
`{behavior:'deny', message}` (`permissionHandler.ts:120-124`). Auto-approve rules:
`bypassPermissions`→allow all (`:172`), `acceptEdits`→allow edits (`:176`),
`plan`→allow non-dangerous read-only tools (`:182`); `AskUserQuestion` and
`ExitPlanMode` **always** prompt (`:137,:164`); allow-listed tools / Bash prefixes
short-circuit (`:142-158`). When a prompt is needed it calls
`handlePermissionRequest` (`:196`) which (a) pushes a push-notification
(`:230`), (b) writes the request into `AgentState.requests[id]`
(`:243-253`), and (c) blocks on a Promise resolved by the `permission` RPC
(see [RPC](#rpc-methods)). The tool-use id is the SDK's `options.toolUseID`
(`:133`) — the same id the app echoes back in its `permission` RPC response.

### Shaping outbound messages like claude transcript lines (SDKToLogConverter)

`SDKToLogConverter` (`claude/utils/sdkToLogConverter.ts:49`) converts each
`SDKMessage` into a `RawJSONLines` object — the exact shape Claude Code writes to
its `~/.claude/projects/<proj>/<sessionId>.jsonl` transcript. It stamps
`parentUuid`, `isSidechain`, `userType:'external'`, `cwd`, `sessionId`, `version`,
`gitBranch`, a fresh `uuid`, and ISO `timestamp` (`sdkToLogConverter.ts:97-107`),
maintains parent-chaining and Task/Agent sidechain parenting
(`:53,:91-96,:225-246`), and carries `isMeta`/`isCompactSummary` flags
(`:120-127,:153`). `result` messages are dropped (`:188-193`).

That `RawJSONLines` is then handed to `session.sendClaudeSessionMessage(body)`
(`apiSession.ts:718`), which runs it through `mapClaudeLogMessageToSessionEnvelopes`
(`claude/utils/sessionProtocolMapper.ts`) to produce one or more `SessionEnvelope`s
and enqueues each as a `role:'session'` message (`apiSession.ts:781-791`). Usage
and summary side-effects are applied from the same raw line
(`apiSession.ts:692-712`).

> **Wire-format nuance:** the shared `sessionProtocol.ts` carries a banner
> ("UNDER REVIEW … NOT used in production; the legacy `role:'user'`/`role:'agent'`
> protocol is the active path", `happy-wire/src/sessionProtocol.ts:1-13`). That
> banner is **stale for this happy-cli HEAD** — `apiSession.sendClaudeSessionMessage`
> actively emits `role:'session'` envelopes (`apiSession.ts:718-723,781-791`).
> ai-or-die can emit either; the session-envelope path is what Claude flows
> through here. Both are decrypted the same way.

### How the Claude session-id is discovered

Two independent mechanisms, both wired in `runClaude.ts`:

1. **SessionStart hook (authoritative, 1:1).** happy-cli starts a loopback HTTP
   server on a random port (`claude/utils/startHookServer.ts:94,151`) that accepts
   `POST /hook/session-start` (`startHookServer.ts:100`). It writes a temp settings
   file registering a `SessionStart` hook whose command is
   `node "<projectRoot>/scripts/session_hook_forwarder.cjs" <port>`
   (`claude/utils/generateHookSettings.ts:29-46`), and passes that file to Claude
   via `--settings` (both modes). When Claude starts/resumes/compacts/forks, it
   POSTs `{session_id, transcript_path, cwd, source, ...}` to the server
   (`startHookServer.ts:66-74,127-130`); the callback binds that id to the Happy
   session and tells the scanner which JSONL to tail
   (`runClaude.ts:462-490`, `session.getMetadata().claudeSessionId`). This is
   preferred because file-watching races when multiple Happy processes run
   (`startHookServer.ts:54-58`).
2. **SDK `system:init` + file-existence wait (remote).** In remote mode
   `claudeRemote` also reads `systemInit.session_id` from the SDK init message and
   waits (≤30s) for `<projectDir>/<session_id>.jsonl` to land before firing
   `onSessionFound` (`claudeRemote.ts:193-230`).

Discovered id is stored in session metadata as `claudeSessionId`
(`api/types.ts:303`) and used for `--resume`, fork backfill, and the JSONL scanner.

The JSONL scanner (`claude/utils/sessionScanner.ts`) tails the on-disk transcript
and forwards only user-typed prompts that the SDK pipeline didn't already send —
i.e. a parallel `claude --resume <id>` terminal (`runClaude.ts:432-451`). It skips
internal event types `file-history-snapshot`/`change`/`queue-operation`
(`sessionScanner.ts:15-19`).

---

## Wire lifecycle (ordered emit/POST sequence)

The concrete ordered sequence a Claude session goes through. Names are the actual
HTTP routes / socket event names / socket-ack calls.

**Phase 0 — Pairing (one-time, see [Pairing](#pairing))**
- `POST /v1/auth/request {publicKey, supportsV2:true}` (create) then poll the same
  route; decrypt the response to obtain either a 32-byte legacy `secret` or a
  `dataKey` account public key (`ui/auth.ts:37-44,162-210`). Persist to
  `~/.happy/access.key`.

**Phase 1 — Machine registration** (`runClaude.ts:116`, `api/api.ts:144`)
- `POST /v1/machines { id, metadata(enc), daemonState?(enc), dataEncryptionKey? }`
  (`api.ts:181-188`). `metadata` is `MachineMetadata` (host, platform,
  happyCliVersion, homeDir, happyHomeDir, happyLibDir, cliAvailability,
  resumeSupport — `api/types.ts:130-151`), encrypted. In `dataKey` mode the
  per-machine key is `machineKey`, wrapped to the account public key and sent as
  `dataEncryptionKey` (`api.ts:154-161`).
- Daemon only: socket connect (`clientType:'machine-scoped'`,
  `happyClient:'cli-daemon/<ver>'`, path `/v1/updates`, `apiMachine.ts:429-439`),
  then `emitWithAck('machine-update-state', {machineId, daemonState(enc),
  expectedVersion})` CAS (`apiMachine.ts:405-409`) and, when metadata changes,
  `machine-update-metadata` CAS (`apiMachine.ts:377-381`). Liveness is a
  fire-and-forget `emit('machine-alive', {machineId, time})` **every 20s**
  (`apiMachine.ts:508-518`), which also re-detects CLI availability and pushes a
  metadata update if it changed.

**Phase 2 — Session create** (`runClaude.ts:170`, `api/api.ts:30`)
- `POST /v1/sessions { tag, metadata(enc), agentState(enc|null), dataEncryptionKey? }`
  (`api.ts:60-67`). `tag` is a random UUID (`runClaude.ts:75`). `metadata` is the
  `Metadata` object (path, host, version, os, machineId, homeDir, happyHomeDir,
  flavor:'claude', lifecycleState:'running', dangerouslySkipPermissions, …
  `runClaude.ts:125-146`, type `api/types.ts:282-327`). In `dataKey` mode a fresh
  random 32-byte `encryptionKey` is generated per session, wrapped to the account
  public key with a version byte, and sent as `dataEncryptionKey`
  (`api.ts:40-52`). Response returns the session id + encrypted metadata/state +
  versions (`api.ts:79-89`, schema `api/types.ts:205-217`).

**Phase 3 — Report to daemon (best-effort)** (`runClaude.ts:256`)
- Local loopback `POST /session-started {sessionId, metadata, encryption?}` to the
  running daemon (`daemon/controlClient.ts` `notifyDaemonSessionStarted`, retried
  ≤3000ms). The daemon matches `metadata.hostPid` to the child PID it spawned and
  fills in the server session id (see [Daemon](#daemon-machine-registration-loopback-control-spawning)).

**Phase 4 — Session socket connect (session-scoped)** (`apiSession.ts:258-371`)
- `io(serverUrl, { auth:{ token, clientType:'session-scoped', sessionId,
  happyClient }, path:'/v1/updates', transports:['websocket'],
  reconnection:false, autoConnect:false })` then `.connect()`
  (`apiSession.ts:258-371`).
- On `connect`: re-register all RPC methods via `rpc-register`
  (`apiSession.ts:282`, `RpcHandlerManager.onSocketConnect` →
  `emit('rpc-register',{method})` `RpcHandlerManager.ts:98-103`) and kick a message
  fetch (`receiveSync.invalidate()`).

**Phase 5 — Set initial agent state + liveness**
- `emitWithAck('update-state', {sid, expectedVersion, agentState(enc)})` to set
  `controlledByUser` (`runClaude.ts:503-506`, `apiSession.ts:948-970`).
- Periodic `socket.volatile.emit('session-alive', {sid, time, thinking, mode})`
  keep-alive (`apiSession.ts:855-865`).

**Phase 6 — Message emit (outbound, encrypted, HTTP batch)**
- Each Claude transcript line → `sendClaudeSessionMessage` → envelopes → enqueue →
  `flushOutbox()` does `POST /v3/sessions/:id/messages { messages:[{content:
  base64(encrypt(envelope)), localId}] }` (`apiSession.ts:647-673,675-684`).
  Batches ≤50, newest-first (`apiSession.ts:645,650-653`). `usage-report` and
  `session-alive` still go over the socket (`apiSession.ts:877-902,855-865`).

**Phase 7 — Receiving inbound (new-message)**
- Socket `update` with `body.t==='new-message'`: if the seq is exactly
  `lastSeq+1` and content is `encrypted`, decrypt inline and route
  (`apiSession.ts:313-329`); otherwise `receiveSync.invalidate()` triggers
  `GET /v3/sessions/:id/messages?after_seq&limit=100` and decrypts each
  (`apiSession.ts:581-643`). Routed user text → `onUserMessage` →
  message queue → Claude (`apiSession.ts:551-560`, `runClaude.ts:637-817`). File
  events (image attachments) route to `onFileEvent`
  (`apiSession.ts:562-576`, `runClaude.ts:617-635`).

**Phase 8 — Metadata / agentState updates (CAS on expectedVersion, over socket)**
- `emitWithAck('update-metadata', {sid, expectedVersion, metadata(enc)})`
  (`apiSession.ts:927`). Ack is `success` / `version-mismatch` (re-read newer,
  retry via `backoff`) / `error` (`apiSession.ts:928-940`).
- `emitWithAck('update-state', {sid, expectedVersion, agentState(enc|null)})`
  (`apiSession.ts:953`), same CAS pattern (`:954-967`).
- Inbound `update` with `body.t==='update-session'` carries versioned encrypted
  `metadata`/`agentState`; applied if `version > local` (`apiSession.ts:330-349`).

**Phase 9 — Permission requests (AgentState.requests + RPC)**
- On a gated tool: `updateAgentState` writes `requests[toolUseID] = {tool,
  arguments, createdAt}` (`permissionHandler.ts:243-253`) + a push notification
  (`:230`). App reads it from agentState, then calls the CLI's `permission` RPC
  (see below). The RPC handler resolves the pending Promise and moves the entry
  to `completedRequests` with status `approved`/`denied`/`canceled`
  (`permissionHandler.ts:344-385`).

**Phase 10 — Teardown** (`runClaude.ts:835-894,955-980`)
- `session.sendSessionDeath()` → `emit('session-end', {sid, time})`
  (`apiSession.ts:870-872`); `session.flush()` (drain outbox + `ping` ack,
  `apiSession.ts:975-991`); `POST /v1/sessions/:id/archive` as a synchronous
  fallback to flip `active=false` (`api.ts:417-435`); optional
  `update-metadata lifecycleState:'archived'` only on explicit archive
  (`runClaude.ts:845-853`); `socket.close()`.

---

## Encryption

Two variants, chosen at pairing time and carried per session/machine as
`encryptionVariant: 'legacy' | 'dataKey'` (`api/types.ts:120`). All JSON payloads
(metadata, agentState, each message envelope, RPC params/results) are
`base64(encrypt(key, variant, obj))` (`apiSession.ts:676`,
`RpcHandlerManager.ts:73,86`). All crypto lives in `api/encryption.ts`.

### Legacy — NaCl secretbox (XSalsa20-Poly1305), symmetric

```ts
// api/encryption.ts:87
export function encryptLegacy(data: any, secret: Uint8Array): Uint8Array {
  const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);            // 24 bytes
  const encrypted = tweetnacl.secretbox(
      new TextEncoder().encode(JSON.stringify(data)), nonce, secret);
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce);                    // wire: [nonce(24)][ciphertext+tag(16)]
  result.set(encrypted, nonce.length);
  return result;
}
```

Key material: a single **32-byte shared `secret`** obtained at pairing and stored
in `~/.happy/access.key`. Both sides hold the same secret; there is no
public-key layer. Decrypt is `decryptLegacy` (`encryption.ts:102`).

### dataKey — AES-256-GCM with 1-byte version framing, per-session key

```ts
// api/encryption.ts:154
export function encryptWithDataKey(data: any, dataKey: Uint8Array): Uint8Array {
  const nonce = getRandomBytes(12);                         // GCM 12-byte nonce
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();                      // 16 bytes
  // Bundle: version(1)=0 + nonce(12) + ciphertext + authTag(16)
  const bundle = new Uint8Array(12 + encrypted.length + 16 + 1);
  bundle.set([0], 0);
  bundle.set(nonce, 1);
  bundle.set(new Uint8Array(encrypted), 13);
  bundle.set(new Uint8Array(authTag), 13 + encrypted.length);
  return bundle;
}
```

Decrypt (`encryption.ts:182`) rejects any `bundle[0] !== 0` (version gate).

### dataKey wrapping to the account public key

In `dataKey` mode the CLI never holds a shared symmetric secret. Instead:
- It generates a **fresh random 32-byte `encryptionKey`** per session
  (`api.ts:43`; per-machine it reuses the persisted `machineKey`, `api.ts:157`).
- It wraps that key **to the account's Curve25519 public key** with libsodium
  sealed-box semantics, then prepends a version byte, and ships it as
  `dataEncryptionKey`:

```ts
// api/api.ts:49  (session)   /  api.ts:158 (machine)
let encryptedDataKey = libsodiumEncryptForPublicKey(encryptionKey, this.credential.encryption.publicKey);
dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
dataEncryptionKey.set([0], 0);          // version byte
dataEncryptionKey.set(encryptedDataKey, 1);
```

`libsodiumEncryptForPublicKey` (`encryption.ts:62`) = ephemeral X25519 keypair +
`tweetnacl.box`, bundled as `[ephemeralPub(32)][nonce(24)][ciphertext]`. The
account **private key never leaves the app** — only the app can unwrap
`dataEncryptionKey` to recover the per-session `encryptionKey` and then decrypt
messages. The CLI holds the account **public key** and its own random data key,
nothing more (`persistence.ts:222-229` — `dataKey` credential is
`{publicKey, machineKey}`, no private key).

### Blob key derivation (attachments)

Attachments are encrypted with NaCl secretbox under a derived blob key:
`legacy → deriveKey(masterSecret,'Happy Blobs',['master'])`,
`dataKey → deriveKey(sessionKey,'Happy Blobs',['session'])`
(`apiSession.ts:393-399`; `deriveKey` is an HMAC-SHA512 key tree,
`utils/deriveKey.ts:29-40`). `encryptBlob`/`decryptBlob` (`encryption.ts:119,135`).

---

## Pairing

The ephemeral X25519 box handshake (`ui/auth.ts`):

```ts
// ui/auth.ts:28  — generate ephemeral keypair
const secret = new Uint8Array(randomBytes(32));
const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);

// ui/auth.ts:37  — announce the ephemeral public key to the server
await axios.post(`${configuration.serverUrl}/v1/auth/request`, {
    publicKey: encodeBase64(keypair.publicKey),
    supportsV2: true
}, { headers: { 'X-Happy-Client': `cli/${configuration.currentCliVersion}` } });
```

- **Mobile:** show a QR of `happy://terminal?<base64url(ephemeralPub)>`
  (`ui/auth.ts:102-103`).
- **Web:** open `${webappUrl}/terminal/connect#key=<base64url(ephemeralPub)>`
  (`api/webAuth.ts:9-11`).
- **Poll:** re-`POST /v1/auth/request` every 1s until `response.data.state ===
  'authorized'` (`ui/auth.ts:160-170`).
- **Decrypt the response** with the ephemeral secret key
  (`decryptWithEphemeralKey`, `ui/auth.ts:172-173,234-246` — parses
  `[ephemeralPub(32)][nonce(24)][ciphertext]`, `tweetnacl.box.open`).
- **Branch on payload length** (`ui/auth.ts:174-210`):
  - `decrypted.length === 32` → **legacy**: the 32 bytes are the shared `secret`.
    Persist `{secret, token}` (`writeCredentialsLegacy`).
  - else if `decrypted[0] === 0` → **dataKey (v2)**: bytes `1..33` are the
    account **public key**; the CLI mints its own `machineKey = randomBytes(32)`.
    Persist `{publicKey, machineKey, token}` (`writeCredentialsDataKey`).
  - else → decryption/parse failure.

The server-returned bearer `token` (`ui/auth.ts:171`) authenticates every
subsequent HTTP call and every socket connection.

After auth, `authAndSetupMachineIfNeeded` ensures a `machineId` (random UUID) in
settings (`ui/auth.ts:277-289`).

---

## RPC methods

Transport: the server relays app→CLI calls over the socket as
`rpc-request {method, params}` with an ack callback (`apiSession.ts:287-289`,
`apiMachine.ts:470-473`). The CLI declares which methods it serves by emitting
`rpc-register {method}` (and `rpc-unregister`) — on registration and on every
reconnect (`RpcHandlerManager.ts:36-57,98-103`). Method names are **scoped**:
`${scopePrefix}:${method}` where `scopePrefix` is the `sessionId` for a session
client (`apiSession.ts:246-248`) or the `machineId` for the machine client
(`apiMachine.ts`). `params` and the returned result are both
`base64(encrypt(key, variant, …))` (`RpcHandlerManager.ts:64-96`).

### Session-scoped RPC methods (`<sessionId>:<method>`)
- **`permission`** — app's response to a permission request. Payload
  `{id, approved, reason?, mode?, allowTools?, updatedInput?}`; resolves the
  pending `canCallTool` Promise and moves the request to `completedRequests`
  (`claude/utils/permissionHandler.ts:344-385`).
- **`abort`** and **`switch`** (local↔remote mode toggle) — registered by the
  per-agent launchers (`claude/claudeLocalLauncher.ts:83-84`,
  `claude/claudeRemoteLauncher.ts:98-99`).
- **`goal-action`** — set/clear a Claude `/goal` (`runClaude.ts:553-605`).
- **`killSession`** — via `registerKillSessionHandler`
  (`runClaude.ts:917`, `claude/registerKillSessionHandler.ts:17`); triggers
  `cleanup({archive:true})`.
- Common file/exec handlers, registered on every session (and also on the machine
  scope) (`registerCommonHandlers`, `apiSession.ts:252`,
  `modules/common/registerCommonHandlers.ts`): **`bash`**, **`readFile`**,
  **`writeFile`** (sha256 CAS), **`listDirectory`**, **`getDirectoryTree`**,
  **`ripgrep`**, **`difftastic`** — all path-validated to the session cwd
  (`registerCommonHandlers.ts:156,242,262,328,387,473,503`).

### Machine-scoped RPC methods (`<machineId>:<method>`) — the daemon serves these
(`api/apiMachine.ts:148-337`)
- **`spawn-happy-session`** (`:148`) — spawn a new Happy CLI session on this
  machine. Params `SpawnSessionOptions {directory, sessionId?, agent?,
  environmentVariables?, resumeClaudeSessionId?, parentSessionId?,
  forkedFromMessageId?, …}` → `SpawnSessionResult {type:'success',sessionId} |
  requestToApproveDirectoryCreation | error`
  (`modules/common/registerCommonHandlers.ts:118-148`).
- **`stop-session`** (`:175`), **`stop-daemon`** (`:319`).
- **`claude-fork-session`** (`:198`), **`claude-list-rewind-points`** (`:221`),
  **`claude-duplicate-session`** (`:240`) — session fork/duplicate lineage.
- **`codex-fork-thread`** (`:271`), **`codex-list-rewind-points`** (`:282`),
  **`codex-duplicate-thread`** (`:297`) — Codex equivalents.
- **`resume-happy-session`** — registered/unregistered conditionally via
  `syncResumeSessionRpcRegistration` based on the machine's `resumeSupport`
  capabilities (`apiMachine.ts:337-364`), advertised in
  `MachineMetadata.resumeSupport`.
- The common file/exec handlers (`bash`, `readFile`, …) are also registered on the
  machine scope (`registerCommonHandlers`, `apiMachine.ts:134`).

---

## Daemon (machine registration, loopback control, spawning)

The optional daemon (`daemon/run.ts`, `controlServer.ts`, `controlClient.ts`,
`types.ts`) is the long-lived per-machine process the app talks to for
listing/spawning/stopping sessions. It owns the single `machine-scoped` socket and
serves the machine RPC methods.

**Machine metadata + registration** (`daemon/run.ts:41-49`, `:818-824`). Built once:
`{host: os.hostname()(+'-dev' when HAPPY_VARIANT==='dev'), platform, happyCliVersion,
homeDir, happyHomeDir, happyLibDir, cliAvailability: detectCLIAvailability(),
resumeSupport: {...detectResumeSupport(), rpcAvailable:true}}`. Registered via
`api.getOrCreateMachine` → `POST /v1/machines` (same as Phase 1). Falls back to an
in-memory stub on network/5xx so the daemon still runs offline.

**Local loopback control API** (`controlServer.ts`). A **Fastify** server bound to
`127.0.0.1` on an **OS-chosen ephemeral port** (`listen({port:0, host:'127.0.0.1'})`,
`controlServer.ts:214`). **No auth token or handshake** — the loopback bind is the
only boundary. Discovery is via `~/.happy/daemon.state.json`
(`{pid, httpPort, startTime, startedWithCliVersion, daemonLogPath}`, written
`run.ts:783-790`); a separate `daemon.state.json.lock` (`O_CREAT|O_EXCL`,
`persistence.ts:341-378`) guards against duplicate instances. All routes are
`POST`, JSON, Zod-validated:

| Route | Line | Body | Response |
|---|---|---|---|
| `/session-started` | `controlServer.ts:39` | `{sessionId, metadata, encryption?}` | `{status:'ok'}` — child self-report webhook |
| `/list` | `controlServer.ts:80` | none | `{children:[{startedBy, happySessionId, pid}]}` |
| `/stop-session` | `controlServer.ts:107` | `{sessionId}` | `{success}` (SIGTERM) |
| `/spawn-session` | `controlServer.ts:127` | `{directory, sessionId?, agent?, environmentVariables?}` | `{success, sessionId}` or `409 {requiresUserApproval, actionRequired:'CREATE_DIRECTORY'}` |
| `/stop` | `controlServer.ts:194` | none | `{status:'stopping'}` |

`controlClient.ts` is the CLI→daemon side: `daemonPost(path, body)` reads
`daemon.state.json` for `httpPort`, probes `process.kill(pid,0)`, then
`fetch('http://127.0.0.1:<port><path>', ...)` (10s timeout). Wrappers:
`notifyDaemonSessionStarted`→`/session-started`, `listDaemonSessions`→`/list`,
`stopDaemonSession`→`/stop-session`, `spawnDaemonSession`→`/spawn-session`,
`stopDaemonHttp`→`/stop`. `ensureDaemonRunning()` spawns `daemon start-sync`
detached and polls readiness (`ensureDaemonRunning.ts:8-33`).

**Session spawning** (`run.ts:508-533`, via `utils/spawnHappyCLI.ts:71-101`). Argv:

```
node --no-warnings --no-deprecation <projectPath>/dist/index.mjs \
  claude --happy-starting-mode remote --started-by daemon [--resume <id>]
```

Spawned with `cwd = directory`, `detached:true`, `stdio:'ignore'`,
`windowsHide:true`, via `cross-spawn` (`run.ts:573-578`). Env injected
(`run.ts:281-345`): `CLAUDE_CODE_OAUTH_TOKEN` (or `CODEX_HOME` for codex), user
`environmentVariables`, lineage vars (`HAPPY_FORKED_FROM_SESSION_ID`,
`HAPPY_FORKED_FROM_MESSAGE_ID`, `HAPPY_FORK_CLAUDE_SESSION_ID`, …), and on the
resume path the `HAPPY_RECONNECT_*` set (`run.ts:709-720`; consumed at
`runClaude.ts:149-168`).

**Reporting the spawned session id back** — *not* read from the child's stdio.
The daemon tracks the child by **PID** (`pidToTrackedSession`) and registers a
**PID-keyed awaiter with a 15s timeout** (`run.ts:609-627`). The child, once its
server-side session exists, calls `notifyDaemonSessionStarted` →
`POST /session-started`; the daemon matches `metadata.hostPid` → the tracked PID,
fills in `happySessionId`, and resolves the awaiter so `spawn-happy-session`
returns `{type:'success', sessionId}` (`run.ts:194-231`).

**Heartbeat + self-restart** (`run.ts:847-941`, 60s; distinct from the 20s
`machine-alive` socket emit). Each tick: prune dead PIDs (`process.kill(pid,0)`);
compare `dist/index.mjs` mtime to the startup snapshot and **self-restart on
upgrade** (release lock/state/socket → `spawnHappyCLI(['daemon','start'],
{detached:true})` → `process.exit(0)`, `run.ts:883-909`); ownership check (if
`daemon.state.json.pid !== process.pid`, another daemon replaced it → shut down);
rewrite the local-file heartbeat. Graceful shutdown pushes
`daemonState.status='shutting-down'` with `shutdownSource ∈
{'mobile-app','cli','os-signal','unknown'}` via `machine-update-state`
(`run.ts:943-968`); remote shutdown arrives as the `<machineId>:stop-daemon` RPC.

---

## Persistence & config

### `~/.happy/` (or `$HAPPY_HOME_DIR`) — `configuration.ts:37-51`
| File | Content |
|---|---|
| `access.key` | Credentials: `{token, secret}` (legacy) **or** `{token, encryption:{publicKey, machineKey}}` (dataKey). `privateKeyFile` (`configuration.ts:47`, `persistence.ts:262-280`). Note: base64 strings on disk; **no account private key ever stored**. |
| `settings.json` | `{schemaVersion, machineId, onboardingCompleted, serverUrl?, webappUrl?, sandboxConfig?, …}`, atomic + file-locked writes (`persistence.ts:38-48,143-207`). |
| `daemon.state.json` / `.lock` | Local daemon PID/httpPort/startTime/heartbeat + exclusive lock (`persistence.ts:73-80,298-397`). |
| `sessions.json` | Persisted sessions (encryptionKey/variant/versions/metadata, 14-day TTL) for resume across daemon restarts (`persistence.ts:401-446`). |
| `logs/` | Log dir (`configuration.ts:45`). |
| `tmp/hooks/session-hook-<pid>.json` | Per-process SessionStart hook settings (`generateHookSettings.ts:21-26`). |

### Config precedence (`configuration.ts`)
- **`HAPPY_HOME_DIR`** env (with `~` expansion) → else `~/.happy` (`:37-43`).
- **`serverUrl`**: `HAPPY_SERVER_URL` env → `settings.serverUrl` → default
  `https://api.cluster-fluster.com` (`:56-59`).
- **`webappUrl`**: `HAPPY_WEBAPP_URL` env → `settings.webappUrl` → default
  `https://app.happy.engineering` (`:60-63`).
- **`currentCliVersion`** = `package.json.version` (`:68`), sent as
  `X-Happy-Client: cli-coding-session/<ver>` on HTTP and `happyClient` in socket
  auth (`api.ts:72`, `apiSession.ts:263`).
- Other env: `HAPPY_EXPERIMENTAL`, `HAPPY_DISABLE_CAFFEINATE`, `HAPPY_VARIANT`
  (`:65-72`); reconnect/fork env: `HAPPY_RECONNECT_*`, `HAPPY_FORK_CLAUDE_SESSION_ID`,
  `HAPPY_FORKED_FROM_SESSION_ID`/`_MESSAGE_ID` (`runClaude.ts:122-154,305`).

---

## Integration notes for ai-or-die (the adapter blueprint)

To drive/monitor ai-or-die Claude sessions from the existing Happy iOS/iPad app
without forking the app, ai-or-die must present itself to the Happy server exactly
as happy-cli does. Concrete requirements:

**1. Pairing + credentials.** Implement the ephemeral-box handshake
(`POST /v1/auth/request` + poll + `decryptWithEphemeralKey`) and support **both**
credential shapes. For a same-account experience, reuse the user's existing
`~/.happy/access.key` if present rather than re-pairing. Store the bearer `token`;
it authenticates all HTTP + socket traffic. **The app's account private key is not
available to ai-or-die** — in dataKey mode you can only *wrap* new data keys to the
account public key; you can never decrypt the app's own private material. This is
the single hardest constraint to honour.

**2. Encryption parity is mandatory.** Port `encryptLegacy` (secretbox) and
`encryptWithDataKey` (AES-256-GCM, version-byte `0` framing) and
`libsodiumEncryptForPublicKey` (X25519 sealed box) byte-for-byte — the app will
reject anything else. Everything on the wire is `base64(encrypt(...))`. Our
control plane already handles Claude JSONL; the new work is the crypto envelope
around it.

**3. Machine + session registration.** `POST /v1/machines` then
`POST /v1/sessions {tag, metadata, agentState, dataEncryptionKey?}`. Map our
session's cwd/host/version into the `Metadata` shape (`api/types.ts:282-327`),
`flavor:'claude'`, `lifecycleState:'running'`. In dataKey mode generate a fresh
32-byte session key and wrap it to the account public key.

**4. Socket (session-scoped).** Connect socket.io to `path:'/v1/updates'` with
`auth:{token, clientType:'session-scoped', sessionId, happyClient}`. Handle
`update` (new-message/update-session), serve `rpc-request`, and emit
`session-alive` heartbeats. Metadata/agentState changes go through the CAS
`update-metadata`/`update-state` acks.

**5. Message bridge — this is where our JSONL binding maps in.** Our control plane
already tails Claude's JSONL transcript (`src/control/*`, sticky-note binding). For
each transcript line: build the `RawJSONLines`-shaped object (we already have it —
it *is* the JSONL line), run the equivalent of `mapClaudeLogMessageToSessionEnvelopes`
to produce `SessionEnvelope`s (or use the simpler legacy `role:'agent'` wrapping),
encrypt, and **`POST /v3/sessions/:id/messages`** in ≤50 batches. Emit `usage-report`
and `summary` (title) as happy-cli does. **Do not** try to speak an SDK control
protocol — either (a) reuse the official `@anthropic-ai/claude-agent-sdk` in a
remote-style driver, or (b) keep our existing node-pty `claude` process and forward
its JSONL, matching happy-cli's *local* mode (app is a mirror + input channel, not
the sole driver).

**6. Inbound (app → Claude).** On `new-message`, decrypt, take `content.text` as a
user prompt, and inject it into our Claude session (our WebSocket `input`
message / node-pty stdin). This is the natural join point with ai-or-die's existing
input plumbing.

**7. Permissions.** Mirror happy-cli: when Claude needs a tool decision, write
`AgentState.requests[toolUseID] = {tool, arguments, createdAt}` via `update-state`,
push a notification, and register the scoped `permission` RPC. The app writes back
`{id, approved, mode, allowTools, updatedInput}`; feed that to the SDK
`canUseTool` return (or to `claude`'s permission mechanism). Move resolved entries
to `completedRequests`.

**8. Session-id discovery.** We already discover Claude's session id via the
SessionStart hook (github-router's hook → our control plane) — that maps directly
onto happy-cli's hook mechanism; stamp it into `metadata.claudeSessionId`. No need
to also run the SDK `system:init` watcher unless we adopt the SDK remote driver.

**9. Teardown.** `session-end` emit + `POST /v1/sessions/:id/archive` fallback +
optional `lifecycleState:'archived'` on explicit archive; leave it unstamped on
Ctrl-C so the session stays resumable — matching happy-cli's semantics
(`runClaude.ts:819-900`).

**Hardest thing to reproduce:** the **dataKey (v2) E2E crypto contract under the
constraint that the app's private key never leaves the app** — ai-or-die must
generate per-session AES-256-GCM keys, wrap them to the account's X25519 public
key with libsodium sealed-box semantics and the exact `version(0)+nonce(12)+
ct+tag(16)` framing, and get every base64/nonce/tag boundary byte-identical, all
while never being able to decrypt anything the app itself originated. Get one byte
of framing wrong and the app silently drops the session.
