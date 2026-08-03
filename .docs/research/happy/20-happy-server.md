# happy-server — relay contract

Reverse-engineered from the Happy monorepo clone at `C:\Users\anikundu\AppData\Local\Temp\happy-study` (HEAD `d2ef88d`). All `file:line` citations are relative to `packages/happy-server/` unless prefixed `docs/`. The goal of this study: determine the minimal HTTP + Socket.IO surface a self-hosted relay must implement so the **unmodified Happy iOS/iPad app** (pointed at a custom server URL) can drive/monitor ai-or-die Claude sessions.

**Bottom line up front:** the relay is a thin, multi-tenant, end-to-end-encrypted sync/fan-out server. It stores opaque encrypted blobs (it never decrypts session content) keyed by an account's Ed25519 public key, mints an opaque bearer token, and fans out changes over Socket.IO rooms with a per-user monotonic `seq`. A minimal reimplementation is clearly viable (see [Integration notes](#integration-notes-for-ai-or-die)).

---

## Overview & stack

- **HTTP:** Fastify v5 with `fastify-type-provider-zod`, 100 MB body limit, CORS `origin:'*'` (`sources/app/api/api.ts:43-51`). Content-type parser added for `application/octet-stream` (attachment PUT) at `api.ts:55-59`.
- **Realtime:** Socket.IO server bound to the same HTTP server, path `/v1/updates` (`sources/app/api/socket.ts:19-47`).
- **DB:** Prisma over PostgreSQL **or** PGlite (embedded WASM Postgres). Provider chosen by `DB_PROVIDER` env (`sources/storage/db.ts:39-55`). Schema at `prisma/schema.prisma`.
- **Auth tokens:** `privacy-kit` persistent token generator/verifier seeded from `HANDY_MASTER_SECRET` (`sources/app/auth/auth.ts:36-59`). Not standard JWT.
- **Server-internal encryption:** `privacy-kit` `KeyTree` derived from `HANDY_MASTER_SECRET`, used only to wrap third-party vendor tokens at rest (`sources/modules/encrypt.ts`). Session/message/machine/artifact payloads are **client-encrypted**; the server stores them opaquely.
- **Multi-process scale-out:** optional Redis streams adapter for Socket.IO when `REDIS_URL` is set (`socket.ts:50-73`); single-process works without it.
- **Two entry points:**
  - `sources/main.ts` — full production server (reads `REDIS_URL`, starts a separate metrics server).
  - `sources/standalone.ts` — portable single-command distribution: `happy-server migrate` then `happy-server serve`, PGlite by default, no Redis (`standalone.ts:186-218`). `sources/index.ts` exposes `startServer()` as a library.
- **Notable deps** (`package.json`): `fastify`, `@fastify/cors`, `@fastify/static`, `@fastify/bearer-auth`, `socket.io`, `@socket.io/redis-streams-adapter`, `ioredis`, `@prisma/client`, `@electric-sql/pglite`, `pglite-prisma-adapter`, `privacy-kit`, `sharp` (image processing), `elevenlabs` (voice).

**End-to-end encryption boundary (critical for relay reimplementation):** almost every payload the app sends is an opaque base64/encrypted string the server persists verbatim. Session messages are stored as `{ t:'encrypted', c:<ciphertext> }` (`sources/app/api/socket/sessionUpdateHandler.ts:205-208`, `v3SessionRoutes.ts:191-194`). `metadata`, `agentState`, `daemonState`, artifact `header`/`body`, KV `value`, access-key `data` are all client-encrypted opaque strings/bytes. The relay does **not** need the encryption keys — it just stores and echoes.

---

## HTTP routes

Route table registered in `sources/app/api/api.ts:99-114`. Auth column: **"Bearer"** means `preHandler: app.authenticate` (validates `Authorization: Bearer <token>`, sets `request.userId`; `sources/app/api/utils/enableAuthentication.ts:6-27`). **"none"** means public/unauthenticated.

### Auth / pairing (`authRoutes.ts`)

| Method | Path | Auth | Body / query | Response |
|---|---|---|---|---|
| POST | `/v1/auth` | none | `{publicKey, challenge, signature}` (all base64) | `{success:true, token}` or `401 {error:'Invalid signature'}` — `authRoutes.ts:9-39` |
| POST | `/v1/auth/request` | none | `{publicKey, supportsV2?}` | `{state:'requested'}` or `{state:'authorized', token, response}` — terminal-pairing poll, `authRoutes.ts:41-87` |
| GET | `/v1/auth/request/status` | none | `?publicKey` | `{status:'not_found'|'pending'|'authorized', supportsV2}` — `authRoutes.ts:90-124` |
| POST | `/v1/auth/response` | Bearer | `{response, publicKey}` | `{success:true}` — approver writes the encrypted response for a pending terminal request, `authRoutes.ts:127-166` |
| POST | `/v1/auth/account/request` | none | `{publicKey}` | `{state:'requested'}` or `{state:'authorized', token, response}` — `authRoutes.ts:169-211` |
| POST | `/v1/auth/account/response` | Bearer | `{response, publicKey}` | `{success:true}` — `authRoutes.ts:214-242` |

Representative handler — account upsert-by-publicKey (`authRoutes.ts:17-39`):
```ts
const isValid = tweetnacl.sign.detached.verify(challenge, signature, publicKey);
if (!isValid) return reply.code(401).send({ error: 'Invalid signature' });
const publicKeyHex = privacyKit.encodeHex(publicKey);
const user = await db.account.upsert({
  where: { publicKey: publicKeyHex },
  update: { updatedAt: new Date() },
  create: { publicKey: publicKeyHex }
});
return reply.send({ success: true, token: await auth.createToken(user.id) });
```

### Sessions (`sessionRoutes.ts`, `v3SessionRoutes.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/sessions` | Bearer | List up to 150 sessions (desc `updatedAt`), `sessionRoutes.ts:14-71` |
| GET | `/v2/sessions/active` | Bearer | Active sessions in last 15 min, `sessionRoutes.ts:74-123` |
| GET | `/v2/sessions` | Bearer | Cursor-paginated (`cursor_v1_<id>`), `changedSince` filter, `sessionRoutes.ts:126-216` |
| POST | `/v1/sessions` | Bearer | Create-or-load by `tag`; body `{tag, metadata, agentState?, dataEncryptionKey?}`. Idempotent per `(accountId,tag)`. Emits `new-session`. `sessionRoutes.ts:219-306` |
| GET | `/v1/sessions/:sessionId/messages` | Bearer | Last 150 messages desc, `sessionRoutes.ts:308-355` |
| POST | `/v1/sessions/:sessionId/archive` | Bearer | Force `active:false`, `sessionRoutes.ts:358-387` |
| DELETE | `/v1/sessions/:sessionId` | Bearer | Delete session + children, `sessionRoutes.ts:390-408` |
| GET | `/v3/sessions/:sessionId/messages` | Bearer | Seq-paginated: `after_seq` (forward asc) XOR `before_seq` (backward desc), `limit≤500`; returns `{messages, hasMore}`. `v3SessionRoutes.ts:65-121` |
| POST | `/v3/sessions/:sessionId/messages` | Bearer | Batch send `{messages:[{content, localId}]}` (1..100), dedup by `localId`, allocates seq batch, emits `new-message`. `v3SessionRoutes.ts:123-241` |

The session record returned to the app (`sessionRoutes.ts:240-255`): `{id, seq, metadata, metadataVersion, agentState, agentStateVersion, dataEncryptionKey(base64|null), active, activeAt, createdAt, updatedAt, lastMessage:null}`.

### Machines (`machinesRoutes.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/machines` | Bearer | Create-or-load by client-supplied `id`; body `{id, metadata, daemonState?, dataEncryptionKey?}`. Emits `new-machine` + `update-machine`. New machines default `active:false`. `machinesRoutes.ts:12-109` |
| GET | `/v1/machines` | Bearer | List all machines, `machinesRoutes.ts:113-136` |
| GET | `/v1/machines/:id` | Bearer | Single machine, `machinesRoutes.ts:139-176` |
| DELETE | `/v1/machines/:id` | Bearer | Delete machine + its access keys (sessions preserved), emits `delete-machine`. `machinesRoutes.ts:180-226` |

### Push tokens (`pushRoutes.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/push-tokens` | Bearer | Register Expo push token (`{token}`), `pushRoutes.ts:10-50` |
| DELETE | `/v1/push-tokens/:token` | Bearer | Remove token, `pushRoutes.ts:53-84` |
| POST | `/v1/sessions/:sessionId/push-event` | Bearer | CLI→server push relay `{kind:'done'|'permission'|'question', title, body, data?}`. Emits `session-event` ephemeral **and** dispatches an Expo push (presence-suppressed). `pushRoutes.ts:89-141` |
| GET | `/v1/push-tokens` | Bearer | List tokens, `pushRoutes.ts:144-170` |

### Access keys (`accessKeysRoutes.ts`) — per `(session, machine)` encrypted blob

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/access-keys/:sessionId/:machineId` | Bearer | Read `{data, dataVersion,...}` or `null`, `accessKeysRoutes.ts:8-78` |
| POST | `/v1/access-keys/:sessionId/:machineId` | Bearer | Create (`409` if exists), `accessKeysRoutes.ts:81-174` |
| PUT | `/v1/access-keys/:sessionId/:machineId` | Bearer | Update with `expectedVersion` optimistic concurrency, `accessKeysRoutes.ts:177-288` |

(There is also a socket `access-key-get`, below — same data over the socket.)

### Artifacts (`artifactsRoutes.ts`) — encrypted user documents

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/artifacts` | Bearer | List (headers only), `artifactsRoutes.ts:12` |
| GET | `/v1/artifacts/:id` | Bearer | Read full artifact, `artifactsRoutes.ts:65` |
| POST | `/v1/artifacts` | Bearer | Create `{id, header, body, dataEncryptionKey}`, `artifactsRoutes.ts:125` |
| POST | `/v1/artifacts/:id` | Bearer | Update with version check, `artifactsRoutes.ts:229` |
| DELETE | `/v1/artifacts/:id` | Bearer | Delete, `artifactsRoutes.ts:360` |

### KV store (`kvRoutes.ts`) — per-user sync'd key-value

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/kv/:key` | Bearer | Single value, `kvRoutes.ts:11` |
| GET | `/v1/kv` | Bearer | List all, `kvRoutes.ts:50` |
| POST | `/v1/kv/bulk` | Bearer | Bulk get `{keys:[...]}` (≤100), `kvRoutes.ts:84` |
| POST | `/v1/kv` | Bearer | Atomic batch mutate `{mutations:[{key, value, version}]}` (version `-1` = new); `409` on version-mismatch; emits `kv-batch-update`. `kvRoutes.ts:117` |

### Account / usage (`accountRoutes.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/account/profile` | Bearer | `{id, firstName, lastName, username, avatar, github, connectedServices}`, `accountRoutes.ts:12-37` |
| GET | `/v1/account/settings` | Bearer | `{settings, settingsVersion}`, `accountRoutes.ts:40-71` |
| POST | `/v1/account/settings` | Bearer | Update `{settings, expectedVersion}`; version-mismatch returns `success:false`; emits `update-account`. `accountRoutes.ts:74-177` |
| POST | `/v1/usage/query` | Bearer | Aggregate usage by hour/day, `accountRoutes.ts:179-311` |

### User / social (`userRoutes.ts`) — all Bearer

`GET /v1/user/:id`, `GET /v1/user/search`, `POST /v1/friends/add`, `POST /v1/friends/remove`, `GET /v1/friends` (`userRoutes.ts:14,62,112,132,152`).

### Feed (`feedRoutes.ts`) — Bearer

`GET /v1/feed` (`feedRoutes.ts:9`).

### Attachments (`attachmentRoutes.ts`) — all Bearer

`POST /v1/sessions/:sessionId/attachments/request-upload` (`:77`), `PUT /v1/sessions/:sessionId/attachments/:attachmentFile` (`:156`, `application/octet-stream`), `POST .../request-download` (`:207`), `GET .../:attachmentFile` (`:262`). Uses S3 or local-file storage.

### Connect / vendor / GitHub (`connectRoutes.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/connect/github/params` | Bearer | Build GitHub OAuth URL, `connectRoutes.ts:48-85` |
| GET | `/v1/connect/github/callback` | none | OAuth redirect handler — **hardcoded** `https://app.happy.engineering` redirects, `connectRoutes.ts:88-165` |
| POST | `/v1/connect/github/webhook` | none (HMAC) | GitHub webhook, signature-verified, `connectRoutes.ts:168-215` |
| DELETE | `/v1/connect/github` | Bearer | Disconnect, `connectRoutes.ts:218-242` |
| POST | `/v1/connect/:vendor/register` | Bearer | Store encrypted vendor token (`vendor∈{openai,anthropic,gemini}`), `connectRoutes.ts:248-267` |
| GET | `/v1/connect/:vendor/token` | Bearer | Decrypt+return vendor token, `connectRoutes.ts:269-292` |
| DELETE | `/v1/connect/:vendor` | Bearer | Remove vendor token, `connectRoutes.ts:294-310` |
| GET | `/v1/connect/tokens` | Bearer | All decrypted vendor tokens, `connectRoutes.ts:312-332` |

### Voice (`voiceRoutes.ts`) — ElevenLabs

`POST /v1/voice/conversations` (Bearer, `:97`), `GET /v1/voice/usage` (Bearer, `:209`).

### Misc / version / dev

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | none | `'Welcome to Happy Server!'` banner (only when no static webapp), `api.ts:63-67` |
| POST | `/v1/version` | none | App version check → `{updateUrl}` (App Store / Play URL or null), `versionRoutes.ts:7-45` |
| POST | `/logs-combined-from-cli-and-mobile-for-simple-ai-debugging` | none | Dev log sink, only registered when `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` set, `devRoutes.ts:7-8` |
| GET | `/files/*` | none | Local-file serving when `isLocalStorage()`, path-traversal guarded, `api.ts:80-96` |
| GET | `/metrics`, `/health` | none | Monitoring (via `enableMonitoring`, `api.ts:75`) |

**Error shape:** 5xx → `{error:'Internal Server Error', message, statusCode}`; 4xx → `{error:<name>, message, statusCode}` (`enableErrorHandlers.ts:31-47`). 404 → `{error:'Not found', path, method}` (skipped when a static webapp SPA fallback is registered, `enableErrorHandlers.ts:52-56`).

---

## Socket.IO realtime contract

### Bootstrap (`sources/app/api/socket.ts:19-47`)

```ts
new Server(app.server, {
  cors: { origin:'*', methods:['GET','POST','OPTIONS'], credentials:true, allowedHeaders:['*'] },
  transports: ['websocket','polling'],
  pingTimeout: 45000,
  pingInterval: 15000,
  path: '/v1/updates',
  allowUpgrades: true, upgradeTimeout: 10000, connectTimeout: 20000,
  serveClient: false,
});
```
`connectionStateRecovery` is **commented out** (`socket.ts:44-46`) — clients do a full REST re-fetch on reconnect. Redis streams adapter attached only when `REDIS_URL` set (`socket.ts:50-52`).

### Handshake auth (`socket.ts:82-121`) — runs as `io.use()` middleware (before `connect`)

Reads from `socket.handshake.auth`:
- `token` (**required**) — verified via `auth.verifyToken` (`socket.ts:106-111`).
- `clientType` ∈ `'session-scoped' | 'user-scoped' | 'machine-scoped'` (default `user-scoped`).
- `sessionId` (required if `session-scoped`, `socket.ts:94-98`).
- `machineId` (required if `machine-scoped`, `socket.ts:100-104`).
- `happyClient` (or header `x-happy-client`) — client version label (`socket.ts:117-119`).
- `appState` — `'active'|'background'` seed for push-suppression presence (`socket.ts:178-181`).

On success sets `socket.data.{userId,clientType,sessionId,machineId,happyClient}` and calls `next()`.

### Rooms & scoping (`sources/app/events/eventRouter.ts:228-243`)

On connect a socket **always** joins `user:<userId>`, plus one scope room:
- user-scoped → `user:<userId>:user-scoped`
- session-scoped → `user:<userId>:session:<sessionId>`
- machine-scoped → `user:<userId>:machine:<machineId>`

RPC registration joins `rpc:<userId>:<method>` (`rpcHandler.ts:66-68`). All rooms are **per-user** — cross-account isolation is enforced by prefixing every room with the authenticated `userId`; there is no global broadcast.

`RecipientFilter` → rooms mapping (`eventRouter.ts:302-315`):
- `all-user-authenticated-connections` → `[user:<u>]` (every socket of the user)
- `user-scoped-only` → `[user:<u>:user-scoped]`
- `all-interested-in-session` → `[user:<u>:session:<sid>, user:<u>:user-scoped]` (session watchers + all user-scoped clients; Socket.IO dedups)
- `machine-scoped-only` → `[user:<u>:machine:<mid>, user:<u>:user-scoped]`

Emit is `io.to(rooms).emit(eventName, payload)`, or `sender.broadcast.to(rooms)` when `skipSenderConnection` is set (`eventRouter.ts:326-330`).

### The two server→client event names

Everything is delivered under exactly **two** Socket.IO event names:
- `update` — **persistent** changes (carry a `seq`). Envelope below.
- `ephemeral` — **transient** presence/activity (no persistence, no seq).

### `update` envelope (`eventRouter.ts:200-208`)
```ts
interface UpdatePayload {
  id: string;         // random 12-char id (randomKeyNaked(12))
  seq: number;        // per-USER monotonic sequence (allocateUserSeq)
  body: { t: UpdateEvent['type']; [key:string]: any };
  createdAt: number;  // Date.now()
}
```
The `seq` is a per-account counter (`Account.seq`, incremented atomically per emission — `sources/storage/seq.ts:10-18`), letting the client order/gap-detect all updates for the user.

### `body.t` union (persistent update types) — `eventRouter.ts:43-162`

| `t` | Emitted by | Key fields |
|---|---|---|
| `new-message` | `sessionUpdateHandler` message, `v3` POST | `sid`, `message:{id,seq,content,localId,createdAt,updatedAt}` (builder uses `sid`, `eventRouter.ts:383-396`) |
| `new-session` | `POST /v1/sessions` | `id, seq, metadata, metadataVersion, agentState, agentStateVersion, dataEncryptionKey, active, activeAt, createdAt, updatedAt` (`:351-369`) |
| `update-session` | `update-metadata` / `update-state` socket | `id, metadata?:{value,version}, agentState?:{value,version}` (`:399-411`) |
| `delete-session` | session delete | `sid` (`:413-423`) |
| `update-account` | `POST /v1/account/settings`, github | `id, settings?:{value,version}, github?, avatar?` (`:425-437`) |
| `new-machine` | `POST /v1/machines` | `machineId, seq, metadata, metadataVersion, daemonState, daemonStateVersion, dataEncryptionKey, active, activeAt, createdAt, updatedAt` (`:451-470`) |
| `update-machine` | machine socket updates | `machineId, metadata?:{value,version}, daemonState?:{value,version}` (`:473-485`) |
| `delete-machine` | `DELETE /v1/machines/:id` | `machineId` (`:487-497`) |
| `new-artifact` | `artifact-create` socket | `artifactId, seq, header, headerVersion, body, bodyVersion, dataEncryptionKey, createdAt, updatedAt` (`:554-582`) |
| `update-artifact` | `artifact-update` socket | `artifactId, header?:{value,version}, body?:{value,version}` (`:584-596`) |
| `delete-artifact` | `artifact-delete` socket | `artifactId` (`:598-608`) |
| `relationship-updated` | social | `uid, status, timestamp` (`:610-628`) |
| `new-feed-post` | feed | `id, body, cursor, createdAt` (`:630-648`) |
| `kv-batch-update` | `POST /v1/kv` | `changes:[{key, value(null=deleted), version(-1=deleted)}]` (`:650-664`) |

> Wire-shape note: several builders emit `sid`/`id` where the TS union field is named `sessionId`/`machineId` (e.g. `new-message` uses `sid` at `:387`, `delete-session` uses `sid` at `:419`). Reimplement to the **builder** output, not the type declaration.

### `ephemeral` types (`eventRouter.ts:166-196`)

| `type` | Meaning | Fields |
|---|---|---|
| `activity` | session alive/thinking | `id(sessionId), active, activeAt, thinking` (`:499-507`) |
| `machine-activity` | daemon alive | `id(machineId), active, activeAt` (`:509-516`) |
| `usage` | token/cost report | `id(sessionId), key, tokens, cost, timestamp` (`:518-527`) |
| `machine-status` | daemon online/offline | `machineId, online, timestamp` (`:529-536`) |
| `session-event` | done/permission/question | `sessionId, kind, title, body, timestamp` (`:543-552`) |

On machine-scoped connect/disconnect the server auto-emits `machine-activity` to `user-scoped-only` (`socket.ts:164-172, 197-204`).

### Client→server socket events (handler tables)

**Session** (`sessionUpdateHandler.ts`):
- `update-metadata` `{sid, metadata, expectedVersion}` → cb `{result:'success'|'version-mismatch'|'error', version, metadata}`; emits `update-session`. (`:13-73`)
- `update-state` `{sid, agentState, expectedVersion}` → analogous; emits `update-session`. (`:75-139`)
- `session-alive` `{sid, time, thinking?}` → emits `activity` ephemeral (no cb). (`:140-184`)
- `message` `{sid, message, localId?}` → persists `{t:'encrypted', c:message}`, allocates user+session seq, emits `new-message` (skips sender). (`:187-246`)
- `session-end` `{sid, time}` → sets `active:false`, emits `activity`. (`:248-289`)

**Machine** (`machineUpdateHandler.ts`):
- `machine-alive` `{machineId, time}` → emits `machine-activity`. (`:13-53`)
- `machine-update-metadata` `{machineId, metadata, expectedVersion}` → CAS, emits `update-machine`. (`:56-147`)
- `machine-update-state` `{machineId, daemonState, expectedVersion}` → CAS + sets `active:true`, emits `update-machine`. (`:150-242`)

**RPC** (`rpcHandler.ts`) — daemon exposes methods; app calls them:
- `rpc-register` `{method}` → joins `rpc:<uid>:<method>`, emits `rpc-registered`. (`:130-143`)
- `rpc-unregister` `{method}` → leaves room, emits `rpc-unregistered`. (`:145-158`)
- `rpc-call` `{method, params}` (with ack cb) → server finds the registered daemon socket cross-replica via `fetchSockets`, forwards as `rpc-request`, relays the ack back as `{ok, result}` / `{ok:false, error}`. 30 s timeout, 15 s reconnect grace. (`:160-256`) The daemon receives `rpc-request` and must ack.
- Errors surface as `rpc-error`.

**Usage** (`usageHandler.ts`): `usage-report` `{key, sessionId?, tokens, cost}` → upserts `UsageReport`, emits `usage` ephemeral. (`:9-123`)

**Artifacts** (`artifactUpdateHandler.ts`): `artifact-read`, `artifact-update`, `artifact-create`, `artifact-delete` — all with ack cbs, all emit corresponding `update`. (`:13,67,258,354`)

**Access key** (`accessKeyHandler.ts`): `access-key-get` `{sessionId, machineId}` → `{ok, accessKey|null}`. (`:8-82`)

**Ping** (`pingHandler.ts`): `ping` → cb `{}`. (`:5-11`)

**App state** (`socket.ts:183-185`): `app-state` `{state:'active'|'background'}` → drives push-notification suppression.

---

## Auth & pairing

### Token minting & verification (`sources/app/auth/auth.ts`)

- **Not JWT.** Uses `privacy-kit.createPersistentTokenGenerator/Verifier` with `service:'handy'`, seeded by `HANDY_MASTER_SECRET` (`auth.ts:36-56`). Public key is derived from the seed, so the same secret ⇒ same signing keypair ⇒ tokens survive restarts.
- `createToken(userId, extras?)` → `generator.new({ user:userId, extras? })` (`auth.ts:67-87`). `extras` can carry `{ session:<terminalAuthRequestId> }` for terminal-paired tokens (`authRoutes.ts:78`).
- `verifyToken(token)` → verifies signature, returns `{userId, extras}`; **cached** in-memory 24 h TTL, max 10 000 entries, LRU-ish eviction (`auth.ts:89-139`).
- Separate ephemeral generator/verifier `service:'github-happy'`, 5 min TTL, for GitHub OAuth state (`auth.ts:47-56, 175-202`).
- `HANDY_MASTER_SECRET` is thus the single root of trust: it seeds the token keypair **and** the `KeyTree` used to wrap vendor tokens at rest (`modules/encrypt.ts:6-10`). Required at startup (`standalone.ts:116-119`).

### `authenticate` preHandler (`enableAuthentication.ts:6-27`)
Reads `Authorization: Bearer <token>`, calls `auth.verifyToken`, sets `request.userId`, else `401`.

### Account creation & pairing flows

- **Direct sign-in (`POST /v1/auth`):** client signs a challenge with its Ed25519 secret key; server verifies with tweetnacl, upserts `Account` keyed by `publicKey` (hex), returns a bearer token. This is the primary path a mobile app uses to obtain a token for its own keypair. (`authRoutes.ts:9-39`)
- **Terminal pairing (`/v1/auth/request` + `/status` + `/response`):** a headless client (CLI/daemon) posts its public key to `/request` and polls `/status`; an already-authenticated device approves by POSTing an encrypted `response` blob (wrapping the shared key) to `/response`. Once approved, `/request` returns `{state:'authorized', token, response}`. The token is minted for the **approver's** account (`answer.responseAccountId`), so the paired terminal acts as that user. (`authRoutes.ts:41-166`)
- **Account pairing (`/v1/auth/account/request` + `/response`):** same shape for account-level linking (`authRoutes.ts:169-242`).

Encryption is entirely client-side E2E; the server only stores/relays the opaque `response` strings and never sees plaintext keys.

---

## Persistence (Prisma)

Schema: `prisma/schema.prisma`. Postgres or PGlite; identical schema. Entities:

- **Account** (`:22-56`): `id(cuid)`, `publicKey @unique`, `seq Int` (per-user update counter), `feedSeq BigInt`, `settings?`/`settingsVersion`, optional `githubUserId`, profile fields (`firstName/lastName/username @unique/avatar`). Root of all ownership relations.
- **TerminalAuthRequest** (`:58-67`) / **AccountAuthRequest** (`:69-77`): pairing rows keyed by `publicKey @unique`, hold `response` + `responseAccountId`.
- **AccountPushToken** (`:79-88`): Expo tokens, unique `(accountId, token)`.
- **Session** (`:94-115`): `id(cuid)`, `tag`, `accountId`, `metadata`/`metadataVersion`, `agentState?`/`agentStateVersion`, `dataEncryptionKey Bytes?`, `seq Int` (per-session message counter), `active`, `lastActiveAt`. Unique `(accountId, tag)` → the create-or-load idempotency key.
- **SessionMessage** (`:117-130`): `sessionId`, `localId?`, `seq`, `content Json` (`{t:'encrypted', c}`). Unique `(sessionId, localId)` → client-supplied dedup; index `(sessionId, seq)`.
- **Machine** (`:205-223`): client-supplied `id`, `metadata`/`metadataVersion`, `daemonState?`/`daemonStateVersion`, `dataEncryptionKey?`, `seq`, `active`, `lastActiveAt`. Unique `(accountId, id)`.
- **AccessKey** (`:281-298`): `(accountId, machineId, sessionId)` unique; `data` (encrypted) + `dataVersion`.
- **Artifact** (`:260-275`): client UUID `id`, `header`/`headerVersion`, `body`/`bodyVersion`, `dataEncryptionKey Bytes`, `seq`.
- **UsageReport** (`:184-199`): `key`, `accountId`, `sessionId?`, `data Json{tokens,cost}`; unique `(accountId, sessionId, key)`.
- **UserKVStore** (`:352-364`): `(accountId, key)` unique, `value Bytes?` (null=deleted), `version`.
- **UserFeedItem** (`:332-346`), **UserRelationship** (`:312-326`, enum `RelationshipStatus`), **VoiceConversation** (`:370-379`), **ServiceAccountToken** (`:241-254`, encrypted vendor tokens), **UploadedFile** (`:225-239`), **GithubUser/GithubOrganization** (`:136-152`), utility tables **GlobalLock/RepeatKey/SimpleCache** (`:158-178`).

### Optimistic-concurrency / seq mechanism

Two distinct counters:
1. **Per-user update `seq`** (`Account.seq`) — every `update`/`new-*`/`delete-*` fan-out gets a globally-ordered `seq` for that user via `allocateUserSeq` (atomic `increment:1`, `storage/seq.ts:10-18`). The client uses it to detect gaps and trigger a REST resync.
2. **Per-entity `version`** — `metadataVersion`, `agentStateVersion`, `daemonStateVersion`, `settingsVersion`, artifact `headerVersion`/`bodyVersion`, KV `version`, access-key `dataVersion`. Every mutating write is a **compare-and-swap**: client sends `expectedVersion`; the handler does `updateMany({ where:{..., <field>Version: expectedVersion }})` and if `count===0` returns `version-mismatch` with the current value so the client can rebase (e.g. `sessionUpdateHandler.ts:40-50`, `machineUpdateHandler.ts:93-120`, `accountRoutes.ts:126-149`). `SessionMessage.seq` is a monotonic per-session counter (`allocateSessionSeq`, batched via `allocateSessionSeqBatch`, `storage/seq.ts:20-45`).

---

## Self-hosting

### Standalone mode (already implemented — `sources/standalone.ts`)

- CLI: `happy-server migrate` then `happy-server serve` (`standalone.ts:186-218`). PGlite by default (`DB_PROVIDER` defaults to `pglite`, `standalone.ts:112-114`).
- `runMigrations()` applies `prisma/migrations/*/migration.sql` manually against a fresh PGlite instance, tracking in `_prisma_migrations` (`standalone.ts:27-109`) — no Prisma CLI / native engine needed at runtime.
- `serve()` requires `HANDY_MASTER_SECRET` (hard error otherwise, `:116-119`), port `3005` default, host `0.0.0.0` default, optionally serves a static webapp from `HAPPY_STATIC_DIR`/`./webapp` (`:123, 149-163`).
- `startServer()` (library, `sources/index.ts:22-50`) forces `DB_PROVIDER=pglite`, sets `PGLITE_DIR` + `HANDY_MASTER_SECRET`, connects DB, `initEncrypt/initGithub/loadFiles/auth.init`, then `startApi`. **No Redis** in this path.

### Static webapp + `__HAPPY_CONFIG__` injection (`api.ts:116-173`)

When `staticDir` is set, `@fastify/static` serves the bundled Happy web app on the same origin, and an `onSend` hook injects `<script>window.__HAPPY_CONFIG__ = {...}</script>` into `index.html` (`api.ts:119-155`). SPA fallback serves `index.html` for any non-`/v1|/v3|/socket|/files|/metrics|/health` GET (`api.ts:157-172`). This is the "one bundle, two behaviors" trick — the served web app calls its own origin.

### Env vars (from `standalone.ts:209-216`, `.env.dev`, `main.ts:24-28`)

| Var | Required? | Role |
|---|---|---|
| `HANDY_MASTER_SECRET` | **Yes** | token keypair seed + at-rest encryption root |
| `DB_PROVIDER` | default `pglite` | `pglite` or `postgres` |
| `PGLITE_DIR` / `DATA_DIR` | default `./data/pglite` | PGlite data dir |
| `DATABASE_URL` | only if postgres | Postgres connection |
| `PORT` | default `3005` | HTTP port |
| `HOST` | default `0.0.0.0` | bind address |
| `REDIS_URL` | optional | multi-process Socket.IO fan-out; standalone omits it |
| `HAPPY_STATIC_DIR` | optional | serve bundled webapp |
| `HAPPY_INJECT_HTML_CONFIG` | optional | JSON injected as `__HAPPY_CONFIG__` |
| `S3_*` | optional | attachment/image storage (else local `/files`) |
| `ELEVENLABS_API_KEY`, `VOICE_WEBHOOK_SECRET` | optional | voice |
| `GITHUB_CLIENT_ID/SECRET/REDIRECT_URL` | optional | GitHub connect |
| `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` | optional | dev log sink |

### The `happy server` single-command plan (`docs/plans/happy-serve-self-host.md`)

The in-progress design (blueprint for what ai-or-die wants):

- **Command:** `happy server` runs the sync server + bundled web app on `localhost` **synchronously in the foreground** (Ctrl-C stops it), and writes `settings.serverUrl` into `~/.happy/settings.json` so the daemon/CLI target it (`docs/plans/happy-serve-self-host.md:5-25, 29-33`).
- **Single settings field** `serverUrl?: string`; URL precedence `HAPPY_SERVER_URL env → settings.serverUrl → default https://api.cluster-fluster.com` (`:37-68`). **No silent fallback** to the public server — fail closed (`:54-57`).
- **PGlite** embedded; migrations bundled; **no Docker, no Redis, no Postgres** (`:325`, tarball layout `:160-176`). Master secret auto-generated on first start: 32 random bytes → `~/.happy/server/master-secret` (0600), reused thereafter; deleting it makes data unreadable (`:262-267`).
- **Web app same-origin trick:** static handler injects `{ serverUrl: location.origin, disableAnalytics: true }` (`:74-91, 132-138`) — matches the already-implemented `api.ts` injection.
- **Bind default `127.0.0.1`**; `--host 0.0.0.0` documented for LAN/mobile with a warning (`:285`). **This is the switch that lets a phone connect.**
- **Open questions relevant to us:** OAuth redirects hardcode `app.happy.engineering` (`:288`); multi-user vs single-user (server is multi-tenant; self-host "probably wants first-client-auto-pairs" — out of v1 scope, `:289`); sharp native dep ~20 MB (`:287`).

---

## Integration notes for ai-or-die

Goal: run a minimal relay that the **unmodified Happy iOS app** connects to (via its in-app "custom server URL" setting) so it can list/open ai-or-die sessions and exchange messages. Everything is E2E-encrypted, so the relay never needs plaintext — it is pure store-and-fan-out.

### Load-bearing surface (must implement)

1. **Auth token minting** — `POST /v1/auth` (challenge/signature → account upsert-by-publicKey → bearer token). The app signs with its own keypair; you must verify with tweetnacl Ed25519 and return an opaque bearer token. You can mint tokens however you like **as long as** your `authenticate` preHandler and the socket handshake verify them consistently. (`authRoutes.ts:9-39`, `enableAuthentication.ts`, `auth.ts`.)
2. **Bearer `authenticate` preHandler** on every data route (sets `userId`). (`enableAuthentication.ts:6-27`.)
3. **Sessions REST:** `GET /v1/sessions`, `POST /v1/sessions` (create-or-load by tag), `GET /v1/sessions/:id/messages`, plus the `/v3/sessions/:id/messages` GET/POST (seq pagination + batch send) — the modern message path. (`sessionRoutes.ts`, `v3SessionRoutes.ts`.)
4. **Socket.IO server on path `/v1/updates`** with the handshake auth contract (token + clientType + optional sessionId/machineId), the per-user room model, and the two emit names `update` (with `{id,seq,body:{t,...},createdAt}`) and `ephemeral`. (`socket.ts`, `eventRouter.ts`.)
5. **Socket handlers the app relies on to drive a session:** `message` (send), `update-metadata`, `update-state`, `session-alive`, `session-end`, `ping`, and the `new-message`/`new-session`/`update-session` fan-outs. (`sessionUpdateHandler.ts`.)
6. **Per-user `seq` counter + per-entity `version` CAS.** The app assumes monotonic `seq` for gap detection and `expectedVersion` optimistic concurrency; skipping these breaks resync and metadata writes. (`storage/seq.ts`, all `update*` handlers.)
7. **Machines** (`POST/GET /v1/machines`, `new-machine`/`update-machine`, `machine-alive`, `machine-update-state`) **and RPC over socket** (`rpc-register`/`rpc-call`/`rpc-request`) — load-bearing **if** ai-or-die represents its host as a Happy "machine/daemon" and wants the app to invoke actions (spawn session, send input) via RPC rather than only via `message`. Decide based on which app affordances you need. (`machinesRoutes.ts`, `machineUpdateHandler.ts`, `rpcHandler.ts`.)
8. **`POST /v1/version`** returns `{updateUrl:null}` — the app pings this on launch; return null to avoid an update nag. (`versionRoutes.ts`.)
9. **`GET /v1/account/profile` + `/settings`** — the app fetches these to render the account; return minimal shapes. (`accountRoutes.ts`.)

### Optional / can stub or 404

- **Push** (`/v1/push-tokens`, `/v1/sessions/:id/push-event`) — needed for background notifications on the phone; can no-op if you accept no push. The app will still work foregrounded.
- **Artifacts, KV, feed, friends/social, voice, attachments, GitHub connect, vendor tokens** — none are required to drive a session. Stub with empty responses (`{artifacts:[]}`, `{tokens:[]}`, `{feed:[]}`, etc.) or 404. Access keys (`/v1/access-keys/...`) are only needed if you implement the machine/RPC end-to-end key exchange.
- **Redis, S3, Postgres** — all optional. A single-process Node server with in-memory Socket.IO rooms + SQLite/PGlite is sufficient for a single user.
- **Pairing endpoints** (`/v1/auth/request`, `/account/request`, `/response`) — only needed if a headless ai-or-die process must be approved by the phone. If the phone signs in directly via `/v1/auth`, pairing is not on the app's critical path.

### Cross-check vs repo docs (and two corrections)

The repo docs (`docs/protocol.md`, `docs/backend-architecture.md`, `docs/realtime-sync-and-rpc.md`, `docs/api.md`, `docs/deployment.md`) corroborate the socket envelope, room model, `body.t` union, and route catalog above. Two places where **source overrides the prose docs** — trust the source:

- **Tokens are privacy-kit persistent tokens, not JWT.** `docs/backend-architecture.md:170` and `docs/user-identity.md:48` call them "JWT signed with HANDY_MASTER_SECRET." The actual implementation (`auth.ts:36-59`) uses `privacy-kit.createPersistentTokenGenerator/Verifier`. Treat the token as an **opaque bearer string** you mint and verify with the same secret-seeded keypair; do not assume JWT structure.
- **Redis is optional, contrary to `docs/deployment.md`.** The deployment doc says Redis is "required by startup (`redis.ping()`)." In current source the ping is guarded: `main.ts:24-27` only pings when `REDIS_URL` is set, and the Socket.IO Redis adapter is attached only when `REDIS_URL` is set (`socket.ts:50`). `standalone.ts`/`index.ts` never touch Redis, and `standalone.ts:213` documents `REDIS_URL` as "optional, not required for standalone." A single-process relay needs no Redis. (`sources/storage/redis.ts` eagerly constructs a client from `REDIS_URL!` but is not imported by the standalone/library path.)

Also note the docs mention `POST /v1/voice/token`; the actual voice routes are `POST /v1/voice/conversations` and `GET /v1/voice/usage` (`voiceRoutes.ts:97,209`). Voice is fully optional for the relay.

Practical consequence for ai-or-die: an **unmodified shipped iOS app** points at a custom relay via the in-app **Settings → Server URL** screen (the `__HAPPY_CONFIG__` injection only reconfigures the *bundled web app*, not the native binary). So the relay must speak the exact documented wire contract; there is no app-side shim.

### Feasibility verdict

**Self-hosting a minimal relay is clearly viable.** The server already ships a Redis-free, Postgres-free, single-command standalone (`standalone.ts` + PGlite), and the in-flight `happy server` plan explicitly targets exactly the "point the app at a localhost URL" model with `--host 0.0.0.0` for mobile. Because the payload layer is E2E-encrypted opaque blobs, ai-or-die's relay only has to implement: challenge/signature auth + bearer verification, the sessions + `/v3` message REST, and the `/v1/updates` Socket.IO room/seq/version fan-out (plus machines+RPC if the app should invoke host actions). That is on the order of a dozen routes and ~8 socket events — a bounded, well-specified subset. The two real integration risks are (a) matching the exact wire shapes where builders diverge from the TS types (`sid` vs `sessionId`, base64 encodings), and (b) the app's assumption of monotonic per-user `seq` for resync, both of which are fully specified above.
