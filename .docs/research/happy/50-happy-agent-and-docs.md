# happy-agent (minimal producer) + repo docs synthesis

Read-only source study of the Happy monorepo at clone `C:\Users\anikundu\AppData\Local\Temp\happy-study` (HEAD `d2ef88d`). Goal: drive/monitor ai-or-die's Claude sessions from the existing Happy iOS app by making ai-or-die speak Happy's protocol, without forking the app. Citations are `packages/happy-agent/src/<file>:<line>` for Part 1 and `docs/<file>` for Part 2. Everything below was read firsthand.

---

## happy-agent: the minimal reference implementation

`packages/happy-agent` is a small, standalone CLI (`@slopus/...`, `X-Happy-Client: cli-control-plane/0.1.0`) that implements the Happy client protocol independently of the big `happy-cli`. It is the cleanest minimal template of "how to be a Happy client/producer." It reuses only two shared things: the crypto layout (reimplemented locally in `encryption.ts`, byte-compatible with `happy-cli`) and the wire types (`@slopus/happy-wire`, imported only as `RawMessage = SessionMessage` in `api.ts:2`).

Important framing: **happy-agent is a control-plane CALLER, not a full session producer.** It creates sessions, sends user messages, reads history, and drives machines via RPC. It does NOT register a machine, does NOT open a machine-scoped socket, and does NOT register RPC handlers or emit the agent-side session-protocol event stream (turn-start/turn-end/text/tool-call). Those producer duties live in `happy-cli`'s daemon + launchers (see Part 2). So happy-agent proves the *client/caller* minimum; ai-or-die additionally needs the *machine + agent-output* half, which happy-agent shows the shape of (it calls the machine RPCs and decrypts the agent stream) even though it doesn't originate it.

### Config and credential storage

- `config.ts:10-15` — `serverUrl` from `HAPPY_SERVER_URL` (default `https://api.cluster-fluster.com`, trailing slashes stripped); `homeDir` from `HAPPY_HOME_DIR` (default `~/.happy`); credentials at `<homeDir>/agent.key`.
- `credentials.ts` — the on-disk file is just `{ token, secret }` where `secret` is base64. On read (`credentials.ts:15-30`) it decodes `secret` and derives the content keypair via `deriveContentKeyPair(secret)`. Written with `mode 0o600`, dir `0o700` (`credentials.ts:32-36`). `Credentials = { token, secret, contentKeyPair:{publicKey,secretKey} }` (`credentials.ts:6-13`).

### Authentication / pairing (QR account-link flow)

`auth.ts:17-88` `authLogin`:
1. Generate ephemeral NaCl box keypair from 32 random bytes (`auth.ts:19-20`).
2. `POST /v1/auth/account/request { publicKey }` (base64 public key) (`auth.ts:25-29`).
3. Print a QR whose payload is `happy:///account?<base64url(publicKey)>` and instruct: scan in Happy app → Settings → Account → Link New Device (`auth.ts:38-48`).
4. Poll the SAME `POST /v1/auth/account/request { publicKey }` every 1s up to 120s (`auth.ts:8-9`, `52-68`). Response type is `{ state:'requested'|'authorized', token?, response? }` (`auth.ts:11-15`).
5. On `authorized`: `decryptBoxBundle(base64decode(response), ephemeral.secretKey)` yields the **account secret** (`auth.ts:70-76`).
6. `writeCredentials(config, token, secret)` (`auth.ts:79`).

`authStatus` prints the derived content public key (`auth.ts:97-107`). Note: this is the **account-linking** flow (`/v1/auth/account/*`), NOT the challenge-signature first-auth flow used by `happy-cli`/mobile (`POST /v1/auth {publicKey,challenge,signature}`, see `docs/api.md` and Part 2 identity). happy-agent piggybacks on an already-provisioned account by linking a new device key to it. `encryption.ts:163-179` `authChallenge` (Ed25519 sign of a 32-byte challenge from the secret seed) exists for the challenge flow but is unused by the CLI paths — it is the primitive for token refresh / direct auth.

### Encryption (`encryption.ts`) — confirmed byte-compatible with happy-cli

Matches `docs/encryption.md` exactly (which is derived from `happy-cli/src/api/encryption.ts`):

- **Key derivation tree** (BIP32-like, HMAC-SHA512): `deriveSecretKeyTreeRoot(seed, usage)` HMACs `"<usage> Master Seed"` (`encryption.ts:49-55`); children HMAC `chainCode` over `0x00 || index` (`encryption.ts:57-64`). Test vectors pinned (`encryption.test.ts:113-123`).
- **Content keypair**: `deriveContentKeyPair(secret)` = box keypair from `SHA-512(deriveKey(secret,'Happy EnCoder',['content']))[0:32]` (`encryption.ts:74-81`). This is the account's long-lived box keypair; its public key is what session/machine data keys are sealed to.
- **legacy variant** = NaCl `secretbox` (XSalsa20-Poly1305): layout `[nonce(24) | ct+tag]` (`encryption.ts:121-141`). Used when a record has no `dataEncryptionKey`; key = account `secret` directly.
- **dataKey variant** = AES-256-GCM: layout `[version(1)=0 | nonce(12) | ct | authTag(16)]` (`encryption.ts:85-117`). Key = per-record 32-byte data key.
- **Sealed data-key bundle**: `libsodiumEncryptForPublicKey` = `tweetnacl.box` with ephemeral key, layout `[ephPub(32) | nonce(24) | ct]` (`encryption.ts:183-194`); on the wire it is wrapped with a leading `version(1)=0` byte (added in `api.ts:273-276`, stripped in `api.ts:104`). `decryptBoxBundle` reverses it (`encryption.ts:196-205`).
- Dispatcher `encrypt/decrypt(key, 'legacy'|'dataKey', data)` (`encryption.ts:145-159`). Cross-variant decrypt fails (`encryption.test.ts:257-262`).

This is identical to `docs/encryption.md`'s three layouts. **No differences** from happy-cli's scheme.

### Record encryption resolution (`api.ts`)

`resolveRecordEncryption` (`api.ts:96-113`) is the whole key-selection logic for both sessions and machines: if `record.dataEncryptionKey` present → strip the version byte, `decryptBoxBundle(bundle, contentKeyPair.secretKey)` → `{key, variant:'dataKey'}`; else legacy → `{key: creds.secret, variant:'legacy'}`. Every field (`metadata`, `agentState`, `daemonState`, message `content.c`) is then decrypted with that resolved key/variant (`api.ts:131-141`).

### API surface it calls (all Bearer-authed, `api.ts:203-208`)

- `GET /v1/sessions` → `{sessions:[RawSession]}` (`api.ts:212-227`)
- `GET /v1/machines` → `[RawMachine]` (`api.ts:229-244`)
- `GET /v2/sessions/active` → `{sessions:[RawSession]}` (`api.ts:246-261`)
- `POST /v1/sessions { tag, metadata(b64), dataEncryptionKey(b64) }` → `{session:RawSession}` (`api.ts:263-300`). Creating a session generates a fresh 32-byte session key, seals it to the content public key (versioned box bundle), encrypts metadata with it. **Tag is idempotent**: "returns existing session when tag already exists" (`api.test.ts:394`).
- `DELETE /v1/sessions/:id` (`api.ts:302-314`)
- `GET /v1/sessions/:id/messages` → `{messages:[RawMessage]}`, each `content.c` decrypted with the session encryption (`api.ts:316-341`).

`RawSession`/`RawMachine` shapes (`api.ts:27-81`) carry `seq`, `metadataVersion`, `agentStateVersion`/`daemonStateVersion`, `dataEncryptionKey`, `active`, `activeAt`.

### Realtime session socket (`session.ts`) — the sync half

`SessionClient` opens a **session-scoped** Socket.IO connection (`session.ts:111-124`):
```
io(serverUrl, { auth:{ token, clientType:'session-scoped', sessionId }, path:'/v1/updates', transports:['websocket'], reconnection:true, reconnectionAttempts:Infinity })
```
It handles two server `update` body types (`session.ts:139-187`):
- `body.t === 'new-message'` with `body.message.content.t === 'encrypted'` → decrypt `content.c`, emit `message` (`session.ts:144-159`).
- `body.t === 'update-session'` → version-gated apply of `metadata`/`agentState` (only if incoming `.version > local version`) → emit `state-change` (`session.ts:160-183`).

Outbound emits:
- `sendMessage(text, meta?)` builds `{ role:'user', content:{type:'text',text}, meta:{sentFrom:'happy-agent', ...} }`, encrypts, and emits `socket.emit('message', { sid, message: <b64> })` (`session.ts:192-209`). `--yolo` sends `meta.permissionMode='yolo'` (`index.ts:384,390`).
- `sendStop()` → `socket.emit('session-end', { sid, time })` (`session.ts:367-372`).

Idle/turn detection (mirrors the v1 session protocol semantics precisely):
- `checkIdleState` (`session.ts:22-42`): archived if `metadata.lifecycleState==='archived'`; idle if agentState is `!controlledByUser && no pending requests`. This is the exact `agentState` shape from `docs/encryption.md` (`controlledByUser`, `requests`).
- `getTurnEvent` (`session.ts:44-67`): looks for `content.role==='session'` and `content.content.ev.t in {turn-start,turn-end}` with a `turn` id — the v1 wire shape (see `docs/session-protocol.md`).
- `isReadyEvent` (`session.ts:69-85`): `role==='agent'`, `content.type==='event' && data.type==='ready'`.
- `waitForIdle`, `waitForTurnCompletion` (`session.ts:245-365`).

### Machine RPC (`machineRpc.ts`) — the remote-control surface it INVOKES

For `spawn`/`resume`, happy-agent opens a **plain (user-token) socket** (no clientType scope) and calls the daemon's registered RPC via the server relay (`machineRpc.ts:70-98`, `144-168`):
```
socket = io(serverUrl, { auth:{ token }, path:'/v1/updates', transports:['websocket'], reconnection:false })
params  = base64( encrypt(machine.encryption.key, machine.encryption.variant, <payload>) )
resp    = socket.timeout(30_000).emitWithAck('rpc-call', { method: `${machine.id}:spawn-happy-session`, params })
```
- **Method naming**: `<machineId>:spawn-happy-session` / `<machineId>:resume-happy-session` (`machineRpc.ts:96,166`).
- **Params/result are encrypted with the MACHINE's key/variant** (not the session key) (`machineRpc.ts:85-93`, `107-111`).
- Spawn payload: `{ type:'spawn-in-directory', directory, approvedNewDirectoryCreation, token: providerToken, agent }` (`machineRpc.ts:86-92`). Resume payload: `{ sessionId }` (`machineRpc.ts:160-162`).
- Result union: `{type:'success', sessionId} | {type:'requestToApproveDirectoryCreation', directory} | {type:'error', errorMessage}` (`machineRpc.ts:8-11`).
- `'RPC method not available'` is normalized to "Machine is offline or its daemon is not connected" (`machineRpc.ts:49-57`) — i.e. no daemon has `rpc-register`ed that method.
- Supported agents: `claude | codex | gemini | openclaw` (`machineRpc.ts:6`, `index.ts:19`).

`docs/realtime-sync-and-rpc.md:64` flags this file as a sharp edge: it "still creates one-off caller sockets for machine spawn and resume instead of reusing a long-lived caller connection."

### CLI commands (`index.ts`) — the full verb list

`auth login|logout|status`, `machines [--active]`, `list [--active]`, `status <id>` (live via a 3s socket wait), `spawn --machine [--path --agent --create-dir]`, `resume <id>`, `create --tag [--path]`, `send <id> <msg> [--yolo --wait]`, `history <id> [--limit]`, `stop <id>`, `wait <id> [--timeout]`. Resume reads `session.metadata.machineId` (`index.ts:88-94`) and gates on `machine.metadata.resumeSupport.{rpcAvailable, happyAgentAuthenticated}` (`index.ts:96-113`). `create` metadata = `{ tag, path, host }` (`index.ts:352-356`). `output.ts` renders markdown/JSON and strips `encryption`/`dataEncryptionKey` from JSON (`output.ts:227-235`).

### The canonical "minimum to be a Happy client" (from happy-agent)

To read/drive existing sessions (what happy-agent does):
1. **Pair**: `POST /v1/auth/account/request {publicKey}`, poll, `decryptBoxBundle(response)` → account secret; persist `{token, secret}`.
2. **Derive** `contentKeyPair = deriveContentKeyPair(secret)`.
3. **List** `GET /v1/sessions` / `/v1/machines`; per record resolve encryption (box-sealed dataKey else legacy), decrypt `metadata`/`agentState`.
4. **Create** `POST /v1/sessions {tag, metadata, dataEncryptionKey}` (fresh sealed AES key).
5. **Live sync**: Socket.IO `/v1/updates` as `session-scoped`; consume `new-message` / `update-session`; emit `message` (encrypted `{role:'user',content:{type:'text',text},meta}`), `session-end`.
6. **Drive machines**: `rpc-call {method:'<machineId>:spawn-happy-session', params:<machine-encrypted>}` on a user-token socket.

To be a full **producer** (what ai-or-die additionally needs, shown by Part 2, not by happy-agent): register a machine (`POST /v1/machines`), open a **machine-scoped** socket, `rpc-register` `spawn-happy-session`/`resume-happy-session` + tool handlers, and for each session emit the agent-side session-protocol stream (turn/text/tool-call/ready) as encrypted `message`s and keep `agentState` updated.

---

## Architecture narrative (from docs/)

### Account / identity model

- **Identity is a public key.** No passwords. `POST /v1/auth { publicKey, challenge, signature }` verifies the signature, `Account.upsert({ where:{ publicKey } })` → a **CUID** account id, returns a Bearer JWT signed with `HANDY_MASTER_SECRET` (`docs/user-identity.md` "Auth Flow"; `docs/backend-architecture.md` "Authentication and tokens": "The backend does not store passwords ... upserts the account by public key and returns a Bearer token"). The same token is used in the Socket.IO handshake (`docs/protocol.md:24-25`).
- **Terminal / device linking**: `POST /v1/auth/request {publicKey, supportsV2?}` → `{state:'requested'|'authorized', token, response}`; `GET /v1/auth/request/status`; `POST /v1/auth/response {response, publicKey}` (Bearer). Account-linking variant: `/v1/auth/account/request` + `/v1/auth/account/response` (`docs/api.md:15-39`). happy-agent uses the **account** variant.
- **One account owns many sessions/machines/artifacts** (`docs/backend-architecture.md` ER diagram: `Account ||--o{ Session/Machine/Artifact`). A session's owning machine is carried in the encrypted `metadata.machineId` (`docs/encryption.md:380-405`), not a DB FK the client sees.
- External-system IDs derive from the CUID: ElevenLabs = HMAC-SHA256(CUID, MASTER_SECRET); RevenueCat = CUID pass-through; GitHub = stored FK; AI vendor keys stored encrypted per `docs/user-identity.md` "Identity Map". Not relevant to session driving.

### Sync / seq model

- **Two transports** (`docs/protocol.md:6-9`): JSON over HTTP on `/v1` and `/v2`; Socket.IO at path `/v1/updates` (websocket + polling); CORS `*`.
- **Three socket scopes** in the handshake `auth` (`docs/protocol.md:28-49`): `user-scoped` (account-wide), `session-scoped` (requires `sessionId`), `machine-scoped` (requires `machineId`, "used by daemons; receives machine updates and emits machine state").
- **Two server→client events**: `update` (persistent, `{id, seq, body:{t,...}, createdAt}`) and `ephemeral` (transient presence/usage) (`docs/protocol.md:51-72`).
- **Per-user monotonic seq is the ordering primitive**: `UpdatePayload.seq` "is a single per-user counter ... apply updates in order and you are consistent for that user" (`docs/protocol.md:16`, `196-197`); `Account.seq` incremented by `allocateUserSeq` (`docs/backend-architecture.md:219-221`). Sessions/machines/artifacts each ALSO carry their own `seq` for per-object ordering.
- **Update body types** (`docs/protocol.md:74-116`): `new-session`, `update-session {id, metadata?, agentState?}` (each `{value,version}` or null), `delete-session`, `new-message {sid, message:{id,seq,content,localId,createdAt,updatedAt}}`, `update-account`, `new-machine`, `update-machine {machineId, metadata?, daemonState?, activeAt?}`, `new-artifact`/`update-artifact`/`delete-artifact`, `relationship-updated`, `new-feed-post`, `kv-batch-update`. Ephemeral: `activity`, `machine-activity`, `usage`, `machine-status` (`docs/protocol.md:118-122`).
- **Optimistic concurrency**: versioned fields (metadata, agentState, daemonState, artifact header/body, access keys, KV) require `expectedVersion`; a mismatch returns `{result:'version-mismatch', version, <current>}` (`docs/protocol.md:17`, `127-161`, `196-199`).
- **Rooms** (`docs/realtime-sync-and-rpc.md:31-40`, `docs/multi-process.md:125-133`): `user:<uid>`, `user:<uid>:user-scoped`, `user:<uid>:session:<sid>`, `user:<uid>:machine:<mid>`, and RPC rooms `rpc:<uid>:<method>`. Server-side clients: `ApiSessionClient` (session-scoped), `ApiMachineClient` (machine-scoped), app `apiSocket` (user-scoped) (`docs/realtime-sync-and-rpc.md:23-27`).
- **Missed-events model**: on reconnect clients do a full REST re-fetch (`docs/realtime-sync-and-rpc.md:48`; `docs/multi-process.md:34` "clients still do a full REST re-fetch on every reconnect"). `connectionStateRecovery` is commented out.

### RPC model

- **Client→server socket verbs** (`docs/protocol.md:124-191`): `update-metadata`, `update-state`, `message {sid, message, localId?}`, `session-alive`, `session-end`, `usage-report`, `machine-alive`, `machine-update-metadata`, `machine-update-state`, artifact ops, access-key-get, and the RPC trio `rpc-register {method}`, `rpc-unregister {method}`, `rpc-call {method, params}` → `{ok, result?|error?}`.
- **Point-to-point RPC over rooms** (`docs/realtime-sync-and-rpc.md:50-60`, `docs/multi-process.md:35-109`): a producer (daemon/session) `rpc-register`s a method → `socket.join('rpc:<uid>:<method>')` (pure Socket.IO room state, **no Redis key, no TTL**). A caller `rpc-call`s → server resolves the room via `io.in(room).fetchSockets()`, forwards `rpc-request` (ack-based), and returns the ack. If the target is briefly absent, the server waits up to 10s (`RPC_RECONNECT_GRACE_MS`); if it dies mid-call a presence poll fast-fails in ~1s; the emit-with-ack cap is 30s (`docs/multi-process.md:241-249`). The daemon's only client-side duty is to re-emit `rpc-register` on reconnect (`docs/multi-process.md:106-108`).
- **What producers register** (`docs/cli-architecture.md:294-373`): the daemon registers `spawn-session` so mobile/server can start a local session; each session registers tool handlers `bash`, file read/write, `ripgrep`, `difftastic` via `registerCommonHandlers`. "All RPC flows through Socket.IO. No direct REST exposure." This is exactly the surface happy-agent's `machineRpc.ts` calls into (`<machineId>:spawn-happy-session`).

### Encryption model

Confirmed identical to happy-agent (above). Server is blind: session metadata, agent state, daemon state, message content, artifacts, KV are stored as opaque client-encrypted blobs (`docs/encryption.md:157-195`, `docs/backend-architecture.md:341-378`). Message content is always wrapped as `{ t:'encrypted', c:'<base64>' }` in `SessionMessage.content` (`docs/encryption.md:222-226`, `351-355`). The only server-side crypto is service-token-at-rest via a KeyTree from `HANDY_MASTER_SECRET` (`docs/encryption.md:486-518`). Two variants: legacy secretbox `[nonce24|ct]`, dataKey AES-GCM `[ver1|nonce12|ct|tag16]`, sealed key bundle `[ephPub32|nonce24|ct]` wrapped with `[ver1|bundle]` (`docs/encryption.md:64-155`).

Load-bearing plaintext shapes (`docs/encryption.md:357-452`):
- **User message** (pre-encryption): `{ role:'user', content:{type:'text',text}, localKey?, meta }`. **Agent message**: `{ role:'agent', content:{ type:'output|codex|acp|event', data }, meta }` — the legacy multi-format shape v1 unified.
- **Session metadata**: `{ path, host, homeDir, version, name, os, summary:{text,updatedAt}, machineId, claudeSessionId, tools, slashCommands, startedFromDaemon, hostPid, startedBy, lifecycleState:'running|archiveRequested|archived', flavor, ... }`.
- **Agent state**: `{ controlledByUser, requests:{<id>:{tool,arguments,createdAt}}, completedRequests:{<id>:{...,status:'canceled|denied|approved', mode:'default|acceptEdits|bypassPermissions|plan|read-only|safe-yolo|yolo', decision, allowTools}} }`.
- **Machine metadata**: `{ host, platform, happyCliVersion, homeDir, ... }`. **Daemon state**: `{ status:'running|shutting-down', pid, httpPort, startedAt, shutdownSource }`.

### Session protocol (v1, current wire) and the Claude producer

`docs/session-protocol.md` is the **v1 unified** protocol: a flat event stream that "replaces the existing mix of `output`, `codex`, and custom `acp` formats ... Old sessions continue using legacy formats; new sessions use this protocol exclusively" (`docs/session-protocol.md:3`). Envelope: `{ id(cuid2), time(ms), role:'user'|'agent', turn?, subagent?, ev:{t,...} }` (`docs/session-protocol.md:36-58`). Wire-nesting per `docs/happy-wire.md:38-47`: outer message `role` is always `'session'`, `content` is the envelope directly, envelope role stays in `content.role`. Events: `text` (with `thinking?`), `service`, `tool-call-start {call,name,title,description,args}`, `tool-call-end {call}`, `file`, `turn-start`, `turn-end {status:'completed'|'failed'|'cancelled'}`, `start`/`stop` (subagent lifecycle). Rules: flat stream, upload-first files, every message has `id`+`time`, 9 event types, provider-agnostic (`docs/session-protocol.md:227-236`).

`docs/session-protocol-claude.md` is the **definitive Claude producer reference** — how `happy-cli` maps Claude JSONL/SDK output into that stream:
- Mapping table (`docs/session-protocol-claude.md:88-102`): assistant text→`agent:text`; thinking→`text{thinking:true}`; `tool_use`(non-Task)→`tool-call-start`; `tool_result`→`tool-call-end`; **`user` plain string → `turn-end(completed)` if open, then emit BOTH `user:text` (legacy) AND `session:text` (migration shadow copy)**; Task tool_use → no parent tool-call, registers a subagent mapping; sidechain → `agent:start`+`agent:text` with `subagent` cuid2.
- Turn lifecycle: starts lazily on first agent output; closed by `closeClaudeSessionTurn(status)` on completion/abort/failure (`:44-51`, `:79-86`, `:399-405`). Ready → `turn-end(completed)` in remote (`:81`).
- Dedup: local scanner keys by `uuid` and seeds processed keys on restart (`:362-377`); remote uses an ordered `OutgoingMessageQueue`, no file replay (`:384-398`).
- Two launch paths: **local** (`claudeLocalLauncher` + `sessionScanner` reading Claude's JSONL) and **remote** (`claudeRemoteLauncher` + SDK stream). Both funnel through `ApiSessionClient.sendClaudeSessionMessage()`.

### Permission model

`docs/permission-resolution.md`: modes `default|acceptEdits|bypassPermissions|plan|read-only|safe-yolo|yolo`; Claude SDK only supports the first four, so `yolo→bypassPermissions`, `safe-yolo→default`, `read-only→default` (`:10-16`). Mode is sent per-message in encrypted `meta.permissionMode` and in the socket envelope `permissionMode` (`:54-58`) — which is exactly what happy-agent's `--yolo` does. Sandbox forces `bypassPermissions`. In v1 the permission request/response is a side-channel via `agentState.requests`/`completedRequests` + RPC, NOT in the transcript (this is the thing v2 changes).

### Backend / self-host shape

Node + Fastify + Socket.IO; Postgres via Prisma; Redis (streams adapter, only needed for multi-replica); S3/MinIO for blobs (`docs/backend-architecture.md:41-47`). Presence: `session-alive`/`machine-alive` debounced, 10-min timeout marks inactive (`docs/backend-architecture.md:223-255`). The standalone entry `packages/happy-server/sources/standalone.ts` runs with **PGlite — no Docker, no Redis** (`docs/plans/happy-serve-self-host.md:325`), which is what makes self-hosting viable.

---

## Roadmap signals

### Session protocol v2 — `docs/plans/session-protocol-v2.md` — status: **DRAFT — under review**

The single most integration-relevant roadmap doc. Key facts:
- **Explicit status marker**: line 2 `Status: **DRAFT — under review**`.
- **v1 was never shipped**: "Key fact: v1 was never published to any CLI release. Production CLIs (0.13.0) use the legacy `role: 'agent'` / `role: 'user'` format. v1 only ran in dev environments. This means we have zero backward compatibility obligations for v1 — we can replace it entirely" (`:718`). So **the stable, in-production producer format today is the LEGACY `{role, content:{type,data}}` message, not v1's `role:'session'` envelope.**
- v2 changes: human-readable field names (`type` not `t`, `callId` not `call`, `toolName` not `name`), flat top-level (drop nested `ev`), drop the `role:'session'` wrapper (use `role:'agent'|'user'` directly), split mutable `tool-call` into immutable `tool-call-start`/`-end`, replace `subagent` with `parentId`+`agentId`, and **put permissions in the stream** as `permission-request`/`permission-response` (audit trail) alongside the RPC side-channel (`:689-704`). 11 event types incl. `photo`/`video`.
- **What v2 explicitly keeps unchanged** (`:680-688`): "Outer encrypted envelope: `{ c, t:'encrypted' }`"; "WebSocket transport: Socket.IO for real-time, REST for message fetch"; "Update types: `new-message`, `update-session`, `update-machine` — unchanged"; "message storage: server stores opaque encrypted blobs"; "`messages.ts` types ... Update* schemas — unchanged"; "RPC mechanism ... still used." So **the entire transport/sync/RPC/encryption layer that ai-or-die targets is stable across v1→v2; only the inner message shape churns.**
- Many open questions remain (`:742-815`): versioning-by-shape vs field, plan messages, read receipts, deltas, attachments-as-parts — "**Decision: deferred.**"

`docs/plans/session-protocol-impl.md` and `docs/plans/session-protocol-unification-v2-draft.md` are the implementation/unification tracks for the same effort (not re-read in full here; v2 is the design of record and is under review).

### happy-wire — `docs/happy-wire.md`

`@slopus/happy-wire` centralizes the shared schemas so CLI/app/server/agent agree (`docs/happy-wire.md:7-9`). It is a **published, versioned** library (`^0.1.0`), and consumers depend on it by version, "mirror[ing] post-publish consumption and reduc[ing] hidden coupling" (`:74-77`). Guidance: "Keep schema additions additive where possible to minimize client breakage" (`:117`) and the publish checklist requires "wire schema changes are backward-compatible or documented" (`:108`). This is the closest thing to a stability contract for the wire types ai-or-die must emit.

### Self-host — `docs/plans/happy-serve-self-host.md`

Directly enabling for ai-or-die (lets us point the Happy app at our own server). All citations `docs/plans/happy-serve-self-host.md`:
- Goal: "One foreground command — `happy server` — runs the sync server + web app on `localhost` and writes the local URL into `~/.happy/settings.json`" (`:5`). PGlite, no Docker/Redis (`:325`).
- **Server URL is already configurable everywhere**: CLI/agent via `HAPPY_SERVER_URL` (default `https://api.cluster-fluster.com`); web app via in-app Settings + `EXPO_PUBLIC_HAPPY_SERVER_URL`; new `settings.serverUrl` precedence `env > settings > default` (`:61-68`, `:322-324`). The mobile app can be pointed at a custom server (in-app Server screen).
- **Fail-closed, no fallback** (`:53-57`): self-host never silently falls back to the public server.
- Open questions relevant to us: multi-user vs single-user ("server is multi-tenant. Self-host probably wants 'first client auto-pairs, rest rejected'. Out of v1 scope", `:289`); OAuth redirect hardcoded to `app.happy.engineering` (`:288`); master secret independent of happy credentials (`:263-267`).
- Status is a plan (not shipped), but the audit section confirms the pieces already exist today.

### Reliable HTTP messages API (v3) — `docs/plans/reliable-http-messages-api.md` + `docs/plans/cli-v3-messages-api.md`

- New `GET /v3/sessions/:id/messages?after_seq=&limit=` (cursor by `seq`) and `POST /v3/sessions/:id/messages {messages:[{content,localId}]}` (batch, atomic, seq-allocated, `localId`-deduped) (`reliable-http-messages-api.md:32-104`).
- **Stability guarantee**: "This is server-side only ... Existing Socket.IO message flow remains fully functional (backward compatibility). The plan is to replace Socket.IO with SSE later" (`:10`), and each new message still "emits `new-message` updates via Socket.IO eventRouter for backward compatibility" (`:104`). Server tasks are `[x]` done; CLI migration `cli-v3-messages-api.md` is largely `[x]` too. Direction: **outbox+cursor for reliability, Socket.IO stays, SSE is the future.** happy-agent still uses the Socket.IO `message` emit (v3 migration is listed as post-completion, `reliable-http-messages-api.md:170-173`).

### Generic ACP runner — `docs/plans/generic-acp-runner.md`

Direction toward provider-agnostic producers: "start any ACP-compatible CLI from a command + args ... maps ACP events to the new session protocol (envelopes)" for Gemini/OpenCode/any future ACP agent, no per-agent runner (`docs/plans/generic-acp-runner.md:5`). Codex already emits the new protocol via `mapCodexMcpMessageToSessionEnvelopes()` (`docs/plans/generic-acp-runner.md:12`). Signal: the producer contract is being generalized so any agent that emits the session-protocol stream is a first-class producer — good for ai-or-die (Claude Code is one such producer).

### Metadata-driven model/mode — `docs/plans/metadata-driven-model-mode-selection.md`

Producer advertises capabilities via metadata: backend "already emits `config_options_update`, `modes_update`, `models_update` events and populates `metadata.models[]`, `metadata.operatingModes[]`, `metadata.currentModelCode`, `metadata.currentOperatingModeCode`" with shape `{code, value, description}` (`docs/plans/metadata-driven-model-mode-selection.md:12-14`). The app renders selectors from these and sends the chosen `key` back in `meta.model` / `meta.permissionMode` for **all** agent types (`docs/plans/metadata-driven-model-mode-selection.md:102-108`). Signal: to expose model/mode pickers for our Claude sessions in the Happy app, ai-or-die should populate `metadata.models[]`/`operatingModes[]` and honor `meta.model`/`meta.permissionMode` on inbound messages.

### Session protocol impl (Codex-first) — `docs/plans/session-protocol-impl.md`

The implementation track for v1 `docs/session-protocol.md`, and it confirms the **exact wire envelope** for a session-protocol message and that **Codex, not Claude, was the first migration**: "CLI (Codex only): Emit session-protocol events **instead of** current codex/acp format ... App: Support **both** legacy and session-protocol formats" (`docs/plans/session-protocol-impl.md:8-10`). The wire shape (`:83-86`, `:175-192`): `sendSessionProtocolMessage()` "Wraps as `{ role: 'session', content: envelope }`", where `envelope = { id, time, role, turn?, invoke?, ev:{t,...} }`. App normalization adds a `type:'session'` branch to `rawAgentRecordSchema` and "Maintain backward compatibility (legacy formats keep working)" (`:48`). Note this doc's envelope uses `invoke` for subagent linkage (`:139`), which v2 renamed to `parentId`/`agentId`. All tasks are marked `[x]` complete. Signal: **Claude was intentionally left on the legacy format while Codex piloted the new envelope** — reinforcing that ai-or-die's Claude producer should emit legacy today.

### Session protocol unification v2 (separate draft) — `docs/plans/session-protocol-unification-v2-draft.md` — status: **DRAFT**

A DISTINCT draft from `session-protocol-v2.md` (line 3 `Status: **DRAFT**`). It keeps the v1 `{id,time,role,turn?,subagent?,ev:{t}}` envelope (`:11-31`, unlike `session-protocol-v2.md` which flattens it) but expands to **14 event types** (`:33`, `:213-230`), adding `service`, `subagent-start`/`subagent-stop` (with `agentId`), `session-control-changed` (`clientType:'cli'|'phone'|'browser'|'daemon'`, `tokenId`), `permission-request`/`permission-response`, `abort`, and `agent-configuration-changed` (`model`, `thinkingLevel`, `permissionMode`, `sandbox`). It also folds `usage` into `turn-end` and declares "`turn-end` IS the ready signal" (`:91`).

Most integration-relevant, it names EXACTLY which legacy producer paths die and which survive (`:314-342`):
- **CLI senders to remove**: `sendAgentMessage` (ACP/Gemini), `sendCodexMessage` ("Dead code — Codex already on envelopes"), `sendSessionEvent` ("`turn-end` replaces ready, `service` replaces error messages").
- **App branches to remove**: `acp`, `codex`, `event` — but **`output` (raw Claude JSONL) is KEPT**: "Keep for historical message replay (oldest format, may exist in production databases)" (`:340`).
- "The CLI already emits only the modern `role: 'session'` envelope for user text. The `ENABLE_SESSION_PROTOCOL_SEND` flag ... was never implemented in code — removed from docs" (`:329-331`).
- happy-wire schema deltas: rename start/stop→subagent-start/stop, add `usage` to turn-end, add the 5 new event types, add `steer` to `text` (`:344-350`).

Side channels that stay OUT of the stream (`:303-310`): activity/presence (`session-alive`/`session-end`), config source-of-truth (metadata + optimistic concurrency), permission/abort real-time delivery (RPC). Open questions unresolved (`:351-356`). Signal: the two v2 drafts DISAGREE on the envelope (flat `type` vs nested `ev.t`) — the inner shape is genuinely unsettled, so ai-or-die must not commit to either v2 yet.

### Stability summary

| Layer | Signal | Verdict |
|---|---|---|
| HTTP `/v1`,`/v2` + Socket.IO `/v1/updates`, scopes, rooms | "Backward compatibility over breaking changes ... New routes/events are added rather than mutating existing shapes" (`docs/protocol.md:19`) | **Stable** |
| Encryption (secretbox/AES-GCM/box, key tree) | Identical across cli/agent/docs; unchanged by v2 | **Stable / frozen** |
| Update body types (`new-message`, `update-session`, `update-machine`) | "unchanged" in v2 (`session-protocol-v2.md:684`) | **Stable** |
| `@slopus/happy-wire` schemas | Published, versioned, "additive where possible" | **Stable-ish** (versioned) |
| Inner session-message shape (v1 flat envelope) | **DRAFT/under review**; "v1 was never published"; legacy `{role, content}` is what production uses | **Churning** — target legacy, watch v2 |
| Messages API | v3 HTTP added, Socket.IO retained, SSE future | **Additive, non-breaking** |
| Permissions | moving from agentState side-channel into the stream (v2) | **Evolving** |

No doc says "do not add new consumers" or "frozen — do not use." The explicit warnings are: v2 is **DRAFT/under review**; several v2 questions are **deferred**; happy-wire asks for **backward-compatible/additive** changes; self-host is a **plan** with multi-user out of scope. The transport is explicitly biased to backward compatibility.

---

## Integration notes for ai-or-die

**What happy-agent proves is the true minimum (client/caller side):** the whole read/drive surface is ~9 small files. To interoperate you need only: the credential file `{token, secret}`, the content-keypair derivation, the two encryption variants + sealed-key bundle, Bearer HTTP for list/create/history, and a `session-scoped` Socket.IO connection speaking `new-message`/`update-session`/`message`/`session-end`. That is genuinely small and reimplementable in Node without any Happy package except `@slopus/happy-wire` (types only) and `tweetnacl`. happy-agent even reimplements the crypto locally, so **there is no hard dependency on the happy-cli codebase.**

**What ai-or-die must add beyond happy-agent to be a full producer the app can start and render:**
1. **Register a machine**: `POST /v1/machines` (create/load by id) with encrypted machine metadata (`host, platform, homeDir, happyCliVersion`) and set `metadata.resumeSupport.rpcAvailable=true`; open a **machine-scoped** socket, send `machine-alive`, keep `daemonState` synced.
2. **Register RPC handlers**: `rpc-register` `spawn-happy-session` and `resume-happy-session` (params/results encrypted with the **machine** key), plus optionally the tool handlers (`bash`, file, ripgrep, difftastic) if we want the app's remote-tools UI. Method names are `<machineId>:<method>`; re-register on reconnect.
3. **Produce the session stream**: for each ai-or-die Claude session, `POST /v1/sessions` (or reuse by tag), then emit encrypted `message`s. **Emit the LEGACY format today** (`{role:'agent', content:{type:'output'|'event', data}}` and `{role:'user', content:{type:'text',text}}`) because "v1 was never published" and production apps normalize legacy. The `output` content type (raw Claude JSONL) is the **oldest and longest-lived** shape — the unification-v2 draft keeps its app-side reader "for historical message replay (oldest format, may exist in production databases)" (`docs/plans/session-protocol-unification-v2-draft.md:340`) — so it is the safest single format to both emit and read back. Optionally shadow-emit the session envelope (as `docs/session-protocol-claude.md` shows the Claude mapper doing) to be v2-ready.

   **Verify empirically, don't trust the spec docs:** there is a genuine contradiction — `docs/session-protocol.md:3` says "new sessions use this protocol exclusively" (the v1 envelope), yet `docs/plans/session-protocol-v2.md:718` says v1 "only ran in dev environments" and shipped CLIs (0.13.0) use legacy. Before committing an emitter, pair a real Happy app against a self-hosted server and observe what shape a live `happy claude` session actually puts on the wire; treat that as the contract, not either doc.
4. **Maintain `agentState`** (`controlledByUser`, `requests`) via `update-state` with `expectedVersion` so the app's idle/busy and permission UI work; honor inbound `meta.permissionMode`.
5. **Lifecycle**: `session-alive` heartbeats, `turn-start`/`turn-end`/`ready` semantics (happy-agent's `session.ts` idle/turn detectors are the exact consumer-side contract to satisfy), `session-end` on stop, `metadata.lifecycleState` for archive.

**Which roadmap direction to build toward:**
- **Target the legacy inner message format for now**, but structure our emitter as a mapper (like `sessionProtocolMapper.ts`) so switching to v2's flat, human-readable envelope (`type`/`callId`/`toolName`, permissions-in-stream) is a localized change. The transport, encryption, sync/seq, RPC, and Update types are stable across the migration, so the risky churn is confined to that one mapper.
- **Prefer a self-hosted Happy server** (`HAPPY_SERVER_URL`/`settings.serverUrl` → our own PGlite standalone) so we control pairing, avoid the public multi-tenant server, and get the fail-closed local-only guarantee. This also sidesteps the account-linking QR flow if we mint our own tokens. Note the multi-user "first client auto-pairs" gap is unsolved upstream — we may need our own single-user gate.
- **Adopt v3 HTTP messages (outbox + `after_seq` cursor)** for reliable delivery rather than fire-and-forget Socket.IO emits; it is additive and already server-side complete.
- **Populate `metadata.models[]`/`operatingModes[]`** to expose Claude model/mode pickers in the app.
- Watch `@slopus/happy-wire` releases (the versioned schema contract) and the v2 draft's resolution before committing to the new inner envelope; until then legacy is the safe, in-production target.

**Sharp edges to expect:** RPC targets that aren't registered fail as "RPC method not available" (must keep `rpc-register` alive across reconnects); optimistic-concurrency `version-mismatch` on metadata/state writes (must re-read + retry); reconnect requires a full REST re-fetch (no state recovery); and 30s is the hard RPC ack ceiling.
