# happy-app — client-side constraints (sync/crypto/auth)

Source study of the **unmodified Happy iOS/iPad app** (`packages/happy-app/sources/`) at clone `C:\Users\anikundu\AppData\Local\Temp\happy-study`, HEAD `d2ef88d`. Read-only. Every claim is cited as `packages/happy-app/sources/…:<line>`; paths below are abbreviated to the file (all under `packages/happy-app/sources/`).

Goal: drive/monitor our ai-or-die Claude sessions from the stock Happy app **without forking it**. This doc records exactly what the app sends, expects, and decrypts, and how it can be pointed at our server. The bottom section (`Integration notes for ai-or-die`) is the client-imposed contract our server/adapter must satisfy byte-for-byte.

---

## Custom-server-URL seam

**This is a real, shipped, no-rebuild feature.** The app resolves its server base URL entirely at runtime from a persisted MMKV value, exposed through a Settings screen.

### Resolution (`sync/serverConfig.ts`)

```ts
// serverConfig.ts:1-8
const serverConfigStorage = new MMKV({ id: 'server-config' }); // separate instance, survives logout
const SERVER_KEY = 'custom-server-url';
const DEFAULT_SERVER_URL = 'https://api.cluster-fluster.com';
```

Precedence, exactly as coded (`serverConfig.ts:10-15`):

```ts
export function getServerUrl(): string {
    return serverConfigStorage.getString(SERVER_KEY) ||        // 1. MMKV 'custom-server-url'
           (globalThis as any).__HAPPY_CONFIG__?.serverUrl ||   // 2. injected global (web)
           process.env.EXPO_PUBLIC_HAPPY_SERVER_URL ||          // 3. build-time env
           DEFAULT_SERVER_URL;                                  // 4. hardcoded default
}
```

Note: `appConfig.ts` also loads a `serverUrl` from the Expo manifest `extra.app` / `EXPO_PUBLIC_SERVER_URL` into `config.serverUrl` (`appConfig.ts:11,89-92`), but the **live socket/HTTP path uses `getServerUrl()`**, whose top precedence is the MMKV custom-server-url. So a user setting the URL in Settings overrides everything short of manual code.

Setter / helpers (`serverConfig.ts`):
- `setServerUrl(url)` — trims + writes MMKV key, or deletes it when falsy (`:17-23`).
- `isUsingCustomServer()` — `getServerUrl() !== DEFAULT_SERVER_URL` (`:39-41`).
- `getServerInfo()` — parses `{hostname, port?, isCustom}` (`:43-63`).
- `validateServerUrl(url)` — only requires a parseable URL with `http:`/`https:` protocol (`:65-79`). No path/host constraints.

### The Settings screen (shipped UI): `app/(app)/server.tsx`

`ServerConfigScreen` (`server.tsx:78`) imports `getServerUrl, setServerUrl, validateServerUrl, getServerInfo` (`server.tsx:12`). Flow:
1. User types a URL into a `TextInput` (`server.tsx:179-195`).
2. On Save (`handleSave`, `server.tsx:119-146`): `validateServerUrl()` for format, then a **live reachability probe** (`validateServer`, `server.tsx:87-117`): `GET <url>` with `Accept: text/plain`, and the response body **must contain the literal string `Welcome to Happy Server!`** (`server.tsx:105`) or it errors with `notValidHappyServer`. Then a destructive confirm, then `setServerUrl(inputUrl)`.
3. Reset (`handleReset`, `server.tsx:148-159`) → `setServerUrl(null)` → back to default.

**Hard client-imposed requirement #1:** our server's root `GET /` must return `200` with a body containing `Welcome to Happy Server!` or the app refuses to save the custom URL.

The screen is reachable from `SettingsView.tsx` (references `serverConfig`), i.e. it is a normal in-app Settings route (`app/(app)/server`). No developer build required.

---

## Socket handshake & event handling

Transport module: `sync/apiSocket.ts` (singleton `apiSocket`, `:318`). It is a Socket.IO **v4 client** (`import { io, Socket } from 'socket.io-client'`, `:1`).

### Connection + auth payload (`apiSocket.ts:88-101`)

```ts
this.socket = io(this.config.endpoint, {
    path: '/v1/updates',
    auth: {
        token: this.config.token,
        clientType: 'user-scoped' as const,
        happyClient: getHappyClientId(),
        appState: getCurrentAppState(),
    },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
});
```

- **Socket.IO path** is `/v1/updates` (not the default `/socket.io/`). Server must mount the Socket.IO endpoint there.
- **Transport is websocket-only** (`transports: ['websocket']`) — no HTTP long-poll fallback. The server must accept a pure WS upgrade.
- **`auth` handshake fields** (sent in the Socket.IO connect handshake, i.e. available server-side as `socket.handshake.auth`):
  - `token` — the account bearer token (from `/v1/auth`).
  - `clientType: 'user-scoped'` — this app instance is the **user** client (as opposed to the CLI's `session-scoped` / `machine-scoped` clients). Fixed literal here.
  - `happyClient` — `getHappyClientId()` = `"<platform>/<version>"`, e.g. `ios/1.2.3`, `web/…`, or `desktop/…` when Tauri (`apiSocket.ts:8-15`).
  - `appState` — `'active'` | `'background'` (`getCurrentAppState()`, `:23-33`).
- Reconnection is automatic and infinite. On reconnect it re-runs the `auth` handshake with the same fields. On a non-recovered (re)connect it fires `reconnectedListeners` (`:274-277`) — this is the app's cue to re-fetch full state.

`updateToken(newToken)` (`:234-243`) tears down and reconnects when the token changes.

### Events the app **listens for**

Low-level lifecycle handlers in `setupEventHandlers()` (`apiSocket.ts:264-311`):
- `connect` (`:268`) → status `connected`; if `!socket.recovered`, fire reconnected listeners.
- `disconnect` (`:279`) → status `disconnected`.
- `connect_error` (`:287`) / `error` (`:294`) → status `error`.
- **`onAny`** (`:302-310`) — this is the key dispatcher: **every** inbound event is looked up in `messageHandlers` (a `Map<event, handler>`) and dispatched. So the set of application events the app understands is whatever `sync.ts` registers via `apiSocket.onMessage(event, handler)`.

Application-level event names registered by `sync.ts` (via `onMessage`) — see **Socket event handlers (sync.ts)** below. The prompt-flagged set is `update`, `ephemeral`, `rpc-request`, `auth`, `error`; the actual registrations are enumerated from `sync.ts` in that section.

### Events the app **emits**

- `rpc-call` with ack (`emitWithAck`) — session/machine RPC. Payload `{ method: '<id>:<method>', params: <encrypted> }`; ack is `{ ok, result | error }` (`apiSocket.ts:146-181`). Two flavors:
  - `sessionRPC(sessionId, method, params)` → method is `` `${sessionId}:${method}` ``; params encrypted with **session** encryption; result decrypted with session encryption (`:146-161`).
  - `machineRPC(machineId, method, params)` → method is `` `${machineId}:${method}` ``; **machine** encryption (`:166-181`).
- `app-state` — `{ state }` focus reporting for push suppression (`sendAppState`, `:187-189`).
- Generic `send(event, data)` / `emitWithAck(event, data)` passthroughs (`:191-201`).

### HTTP requests (`apiSocket.request`, `apiSocket.ts:207-228`)

All REST calls go to `${endpoint}${path}` with headers:
```
Authorization: Bearer <token>
X-Happy-Client: <platform>/<version>   // getHappyClientId()
```
Credentials come from `TokenStorage.getCredentials()`. The per-feature modules (`apiPush`, `apiKv`, `apiArtifacts`, etc.) build their own `fetch` with the same `Authorization` + `X-Happy-Client` headers and `getServerUrl()` base.

### Socket event handlers (from `sync/sync.ts`)

`SyncManager.subscribeToUpdates` registers **exactly two** application-level socket events (`sync.ts:2103-2106`):
```ts
apiSocket.onMessage('update', this.handleUpdate.bind(this));       // durable/persisted changes
apiSocket.onMessage('ephemeral', this.handleEphemeralUpdate.bind(this)); // transient signals
```
**There is no `rpc-request`, `auth`, `ping`, or `error` application handler.** Auth is only the connect-time handshake payload; transport `connect`/`disconnect`/`connect_error`/`error` live in `apiSocket.ts`. RPC is entirely **client-initiated** (`rpc-call` with ack; no server-initiated RPC to the app). So the only two server→client push events that matter are `update` and `ephemeral`.

**`update` handler (`handleUpdate`, `sync.ts:2132`)** validates with `ApiUpdateContainerSchema` (drops the update on failure) then dispatches on `body.t` via an if/else-if chain (`sync.ts:2143-2650`):
- `new-message` (`:2143`) → get session encryption by **`body.sid`**, decrypt+normalize the message, toggle thinking on task/turn markers, enqueue or invalidate for refetch.
- `new-session` (`:2236`) → just `sessionsSync.invalidate()` (forces `GET /v1/sessions`; no data carried).
- `delete-session` (`:2239`, keyed by **`body.sid`**), `update-session` (`:2261`, keyed by **`body.id`** — note the field-name inconsistency) → decrypt `agentState`/`metadata` deltas, surface permission requests to voice hooks.
- `update-account` (`:2324`) → merge profile; decrypt `settings.value` via `decryptRaw`.
- `new-machine` (`:2368`) → unwrap inline `dataEncryptionKey`, `initializeMachines`, decrypt metadata/daemonState.
- `update-machine` (`:2429`), `delete-machine` (`:2481`), `relationship-updated` (`:2491`), `new-artifact` (`:2510`, unwraps its `dataEncryptionKey` → `ArtifactEncryption`), `update-artifact` (`:2557`), `delete-artifact` (`:2611`), `new-feed-post` (`:2621`).
- **`kv-batch-update` is schema-valid but has NO branch — silently ignored** (`apiTypes.ts:132-139` declares it; no handler). Do not rely on it reaching the app.

**`ephemeral` handler (`handleEphemeralUpdate`, `sync.ts:2678`)** validates with `ApiEphemeralUpdateSchema`, then:
- `activity` (`:2690`) → debounced (2000ms) session active/activeAt/thinking update.
- `machine-activity` (`:2696`) → machine active/activeAt.
- `session-event` (`:2712`) → `notifyUnreadMessage()` only.
- **`usage` is schema-valid but has NO branch — silently ignored.**

### Initial-state HTTP fetches at startup (`sync.ts`)
All with `Authorization: Bearer` + `X-Happy-Client`, base `getServerUrl()`:
- `GET /v1/sessions` (`sync.ts:920`) → `{ sessions: [{ id, tag, seq, metadata:<b64>, metadataVersion, agentState:<b64>|null, agentStateVersion, dataEncryptionKey:<b64>|null, active, activeAt, createdAt, updatedAt, lastMessage:ApiMessage|null }] }`.
- `GET /v1/machines` (`sync.ts:1295`) → a **bare JSON array** (not `{machines:[…]}`) of `{ id, metadata, metadataVersion, daemonState?, daemonStateVersion?, dataEncryptionKey?, seq, active, activeAt, createdAt, updatedAt }`.
- `GET /v1/account/settings` (`sync.ts:1615`) → `{ settings:<b64>|null, settingsVersion }`; `POST` same URL to push `{ settings:<encryptRaw>, expectedVersion }`.
- `GET /v1/account/profile` (`sync.ts:1661`) → plaintext profile.
- `POST /v1/version` (`sync.ts:1710`) → `{platform, version, app_id}` update check.
- **Messages are lazy per-session (not a startup global fetch)** via `apiSocket.request`, path **`/v3`**: `GET /v3/sessions/{id}/messages?before_seq={2147483647}&limit=100` (initial), `?after_seq=` (forward), `?before_seq=` (older). Response `{ messages: ApiMessage[], hasMore }`; each `ApiMessage.content = { t:'encrypted', c:<b64> }`.
- Artifacts via `apiArtifacts.ts` (`GET /v1/artifacts`), KV via `apiKv.ts` (`/v1/kv`) — **`sync.ts` itself never calls KV**.

### Per-object `dataEncryptionKey` unwrap at fetch (`sync.ts`)
`fetchSessions` (`sync.ts:950-963`): for each session, if `dataEncryptionKey` present → `encryption.decryptEncryptionKey(...)` → `Uint8Array`; else `null`; then `encryption.initializeSessions(map)`. `fetchMachines` mirrors it (`sync.ts:1336-1359`). A **null** key selects the legacy `SecretBoxEncryption(masterSecret)` path (see below).

---

## Decryption the app will accept

All content is end-to-end encrypted; the server only ever stores/forwards opaque base64 blobs. The app derives its keys from a single 32-byte **master secret** and will accept exactly the framings below. Getting these byte-for-byte right is the whole ballgame.

### Master secret and the key tree

`credentials.secret` is a **base64url-encoded 32-byte** value; on init it is decoded and must be exactly 32 bytes (`sync.ts:2797-2799`), then `Encryption.create(secretKey)` runs (`sync.ts:2801`).

`Encryption.create` (`sync/encryption/encryption.ts:14-30`) derives:
- `contentDataKey = deriveKey(master, 'Happy EnCoder', ['content'])` (`:17`) — then a **crypto_box keypair** from it: `contentKeyPair = crypto_box_seed_keypair(contentDataKey)` (`:20`). `encryption.contentDataKey` publicly exposes `contentKeyPair.publicKey` (`:50`).
- `anonID = hex(deriveKey(master, 'Happy Coder', ['analytics','id'])).slice(0,16)` (`:23`).
- `masterBlobKey = deriveKey(master, 'Happy Blobs', ['master'])` (`:26`) — for legacy-session blobs.

**Key-tree derivation** (`encryption/deriveKey.ts`) — BIP32-like HMAC-SHA-512 tree:
- Root: `I = HMAC_SHA512(key = seed, data = utf8(usage + ' Master Seed'))`; `key = I[0:32]`, `chainCode = I[32:64]` (`deriveKey.ts:8-14`). **Note the HMAC arg order: the seed is the HMAC *key*, the string is the *message*.**
- Child: `data = 0x00 || utf8(index)`; `I = HMAC_SHA512(key = chainCode, data)`; `key = I[0:32]`, `chainCode = I[32:64]` (`deriveKey.ts:16-35`).
- `deriveKey(master, usage, path)` = root(master, usage) then walk each `path` segment as a child (`deriveKey.ts:37-46`).
- HMAC-SHA-512 is a hand-rolled implementation over `expo-crypto` SHA-512 (`encryption/hmac_sha512.ts`), block size 128, standard ipad/opad. Interoperable with any standard HMAC-SHA-512.

So a server that knows the master secret can derive the identical `contentDataKey`, `contentKeyPair`, blob keys, etc.

### Per-object data keys (`dataEncryptionKey`)

Each session/machine/artifact record carries an optional base64 `dataEncryptionKey` string. The app unwraps it in `Encryption.decryptEncryptionKey(encrypted)` (`encryption.ts:195-215`):
```ts
const encryptedKey = decodeBase64(encrypted, 'base64');
if (encryptedKey[0] !== 0) return null;             // version byte 0x00 required
const decrypted = decryptBox(encryptedKey.slice(1), this.contentKeyPair.privateKey);
```
i.e. **wrapped-key framing = `0x00` version byte ‖ crypto_box sealed-to-content-pubkey bundle**. The bundle (`decryptBox`, `libsodium.ts:22-34`) is `ephemeralPublicKey(32) ‖ nonce(24) ‖ crypto_box_easy ciphertext`. The inverse `encryptEncryptionKey(key)` (`encryption.ts:217-224`) produces `0x00 ‖ encryptBox(key, contentKeyPair.publicKey)` — i.e. the app encrypts data keys **to itself**.

`openEncryption(dataKey)` (`encryption.ts:57-62`): if a per-object `dataKey` is present → `AES256Encryption(dataKey)`; if **null** → the **legacy `SecretBoxEncryption(masterSecret)`**. `initializeSessions`/`initializeMachines` build one encryptor per object and cache it (`encryption.ts:72-99, 137-155`).

### The two content framings (`sync/encryption/encryptor.ts`)

The app decrypts message/metadata/state/RPC content through an `Encryptor & Decryptor`. There are two implementations, chosen per object by whether a `dataKey` exists:

**1. `AES256Encryption` (modern, per-object `dataKey`)** — `encryptor.ts:81-125`:
- Key: the raw 32-byte `dataKey`, base64-encoded into `secretKeyB64` (`:87`).
- Encrypt (`:90-102`): `output = 0x00 ‖ AES-256-GCM( JSON.stringify(item) )`. The leading byte is a **version byte `0x00`** (`:97-98`); the rest is the GCM blob.
- Decrypt (`:104-125`): require `item[0] === 0` (`:113`), then `AES-GCM-decrypt( base64(item.slice(1)) )`, then `JSON.parse`.
- The AES-GCM wire format (`encryption/aes.ts` native + `encryption/aes.web.ts` web) is **`nonce/IV(12) ‖ ciphertext ‖ authTag(16)`**, base64. Web impl is explicit: `IV_LEN = 12`, `concat(iv, ciphertext+tag)` (`aes.web.ts:24,32-37,43-52`); native `rn-encryption` uses the same `AES.GCM.seal` layout (documented `aes.web.ts:5-8`). Plaintext is the **UTF-8 bytes of the JSON string**.

  So the **on-the-wire message blob = base64( `0x00` ‖ IV(12) ‖ AES-256-GCM-ciphertext ‖ tag(16) )**, key = the per-session 32-byte dataKey, AAD = none.

**2. `SecretBoxEncryption` (legacy, null `dataKey`)** — `encryptor.ts:20-44`, backed by `encryption/libsodium.ts`:
- `encryptSecretBox(data, secret)` = `nonce(24) ‖ crypto_secretbox_easy( utf8(JSON.stringify(data)), nonce, secret )` (`libsodium.ts:36-43`). XSalsa20-Poly1305.
- `decryptSecretBox` (`libsodium.ts:45-57`): split `nonce = data[0:24]`, open, `JSON.parse(utf8(...))`.
- Key = the **master secret** itself (`encryption.ts:47`).

  So legacy blob = base64( `nonce(24)` ‖ `crypto_secretbox` ) with key = masterSecret. **No version byte** (contrast with AES path).

There is also `BoxEncryption` (`encryptor.ts:46-79`) — seed→crypto_box keypair, JSON, used for the wrapped-key path conceptually, but message content uses the two above.

### How each object type is decrypted

`SessionEncryption` (`sync/encryption/sessionEncryption.ts`) wraps the chosen encryptor:
- **Messages**: `decryptMessages(messages)` (`:26-94`) — only messages whose `content.t === 'encrypted'` are decrypted; it base64-decodes `message.content.c` (`:59-61`) and runs `encryptor.decrypt`. Result → `DecryptedMessage { id, seq, localId, content, createdAt }` (`storageTypes.ts:179-185`). So the wire shape of an encrypted message is `content: { t: 'encrypted', c: <base64 blob> }`.
- **Metadata**: `decryptMetadata(version, encrypted)` (`:147-168`) → decrypt → `MetadataSchema.safeParse` (`storageTypes.ts:7-65`).
- **Agent state**: `decryptAgentState(version, encrypted)` (`:181-206`) → `AgentStateSchema.safeParse` (`storageTypes.ts:113-134`).
- **RPC params/result**: `encryptRaw` / `decryptRaw` (`:118-134`) — same encryptor, base64.

`MachineEncryption` mirrors this for `metadata` (`MachineMetadataSchema`), `daemonState`, and raw RPC (`machineEncryption.ts`).

`ArtifactEncryption` (`sync/encryption/artifactEncryption.ts`) is always `AES256Encryption(dataEncryptionKey)` (`:9-11`) with a fresh random 32-byte key per artifact (`:16-18`), used for `header`/`body`.

### Encoding primitives
- base64: native via `react-native-quick-base64`, web via `atob/btoa` chunked; `base64url` variants strip padding + swap `-_`/`+/` (`encryption/base64.ts`, `base64.native.ts`).
- libsodium: native `@more-tech/react-native-libsodium`, web `libsodium-wrappers` (`libsodium.lib.ts`, `libsodium.lib.web.ts`).

---

## Message model & normalization

Rendering data flow: **wire `ApiMessage`** → decrypt → **`RawRecord`** (JSON) → `normalizeRawMessage()` → **`NormalizedMessage[]`** → reducer flattens → **`Message` union** (`sync/typesMessage.ts`) that the UI renders.

### Wire container (`sync/apiTypes.ts`)
- `ApiMessage` / update schemas are re-exported from the shared `@slopus/happy-wire` package (`apiTypes.ts:2-19`). An encrypted message's `content` is `{ t: 'encrypted', c: <base64> }` (consumed in `sessionEncryption.ts:42,60`).
- `ApiUpdateContainerSchema = { id, seq, body: ApiUpdate, createdAt }` (`apiTypes.ts:169-174`) — the envelope for every `update` socket event.
- `ApiUpdateSchema` union (`apiTypes.ts:143-158`): `new-message`, `new-session`, `delete-session`, `update-session (state)`, `update-account`, `update-machine (state)`, `new-machine`, `delete-machine`, `new-artifact`, `update-artifact`, `delete-artifact`, `relationship-updated`, `new-feed-post`, `kv-batch-update`. Each is discriminated by a `t` literal.
- `ApiUpdateNewMachineSchema` (`apiTypes.ts:49-62`) carries `dataEncryptionKey` (nullish) inline so a new machine can be decrypted without a refetch.
- Ephemeral (`ApiEphemeralUpdateSchema`, `apiTypes.ts:225-230`): `activity` `{id,active,activeAt,thinking}`, `usage` `{id,key,timestamp,tokens{…},cost{…}}`, `machine-activity` `{id,active,activeAt}`, `session-event` `{sessionId,kind:'done'|'permission'|'question',title,body,timestamp}`.

### The rendered `Message` union (`sync/typesMessage.ts`)
```ts
export type Message = UserTextMessage | AgentTextMessage | ToolCallMessage | ModeSwitchMessage; // :74
```
- `UserTextMessage` `{ kind:'user-text', id, localId, createdAt, text, displayText?, meta?, claudeUuid?, codexItemId? }` (`:25-44`).
- `AgentTextMessage` `{ kind:'agent-text', id, localId, createdAt, text, isThinking?, meta? }` (`:54-62`).
- `ToolCallMessage` `{ kind:'tool-call', id, localId, createdAt, tool: ToolCall, children: Message[], meta? }` (`:64-72`).
- `ModeSwitchMessage` `{ kind:'agent-event', id, createdAt, event: AgentEvent, meta? }` (`:46-52`).
- `ToolCall` `{ name, state:'running'|'completed'|'error', input, createdAt, startedAt, completedAt, description, result?, permission? }` (`:4-22`). **Tool permission requests ride on `ToolCall.permission`** `{ id, status:'pending'|'approved'|'denied'|'canceled', reason?, mode?, allowedTools?, decision?, date? }` (`:13-21`).
- `MessageMeta` (`sync/typesMessageMeta.ts:4-15`): `sentFrom?, permissionMode?, model?, fallbackModel?, customSystemPrompt?, appendSystemPrompt?, allowedTools?, disallowedTools?, effort?, displayText?`.

`messageToEvent.parseMessageAsEvent` (`sync/reducer/messageToEvent.ts:23-73`) converts certain agent messages into `AgentEvent`s (e.g. `Claude AI usage limit reached|<ts>` → `limit-reached`; `mcp__happy__change_title` tool → title event; `EnterPlanMode`/`enter_plan_mode` → "Entering plan mode").

### Raw record & normalization detail (`sync/typesRaw.ts`, `sync/reducer/reducer.ts`)

`normalizeRawMessage(id, localId, createdAt, raw)` is defined **in `typesRaw.ts:738`** (not a separate file). It returns **one `NormalizedMessage | null`** per call. The reducer (`reducer.ts:262`, `reducer(state, messages, agentState?)`) consumes the already-normalized array and flattens each agent record's `content[]` into individual UI `Message`s; it never calls `normalizeRawMessage` itself.

**Top-level discriminator is `role`** (not `t`) — `rawRecordSchema` is a `z.discriminatedUnion('role', …)` (`typesRaw.ts:433-458`) with exactly three variants:
- `role:'user'` → `content: { type:'text', text: string }`, optional `meta` (`typesRaw.ts:442-448`). Flat object, **no content array**. Exact JSON: `{ "role":"user", "content":{"type":"text","text":"…"}, "meta":{…} }`.
- `role:'agent'` → `content: rawAgentRecordSchema` (`typesRaw.ts:275-378`), a `z.discriminatedUnion('type', …)` over `'output' | 'event' | 'codex' | 'session' | 'acp'`.
- `role:'session'` → `content: { type:'session', data: sessionEnvelopeSchema }` (the newer unified realtime-session envelope, `typesRaw.ts:104-134`).

A `z.preprocess` (`preprocessMessageContent`, `typesRaw.ts:385-431`) runs **before** union matching: it rewrites hyphenated Codex/Gemini `tool-call`/`tool-call-result` items into canonical Claude `tool_use`/`tool_result` shape, and re-wraps a shorthand `role:'session'` envelope.

**Canonical content-item schemas** (Claude Messages-API shape, `typesRaw.ts:137-176`), used inside `content.type==='output', data.type==='assistant'/'user'` where `message.content` is `array(rawAgentContentSchema)`:
- text: `{ type:'text', text }`.
- **tool call**: `{ type:'tool_use', id, name, input }` — `id` correlates the later result; `name` is the tool; `input` is `any`.
- **tool result**: `{ type:'tool_result', tool_use_id, content: string|[{type:'text',text}], is_error?, permissions?{ date, result:'approved'|'denied', mode?, allowedTools?, decision? } }`.
- thinking: `{ type:'thinking', thinking }` (passthrough preserves Claude `signature`).
All are `.passthrough()`. Hyphenated `tool-call`/`tool-call-result` forms are also accepted and auto-normalized (`typesRaw.ts:191-263`).

A full Claude **agent text/tool** record:
```json
{ "role":"agent", "content":{ "type":"output", "data":{
    "type":"assistant",
    "message":{ "role":"assistant", "model":"claude-…",
      "content":[ {"type":"text","text":"…"}, {"type":"tool_use","id":"toolu_…","name":"Bash","input":{…}} ],
      "usage":{…} },
    "uuid":"<claude-msg-uuid>", "parentUuid":null } } }
```

**`NormalizedMessage`** (`typesRaw.ts:512-538`): `({role:'user',content:{type:'text',text}} | {role:'agent',content:NormalizedAgentContent[]} | {role:'event',content:AgentEvent}) & { id, localId, createdAt, isSidechain, meta?, usage?, claudeUuid?, codexItemId? }`. `NormalizedAgentContent` (`typesRaw.ts:470-511`) items: `text | thinking | tool-call | tool-result | summary | sidechain`, each (except summary) carrying `uuid`/`parentUUID`.

**`AgentEvent`** union (`typesRaw.ts:20-31`): `{type:'switch',mode:'local'|'remote'} | {type:'message',message} | {type:'limit-reached',endsAt} | {type:'ready'}`. Reaches an agent record via `content.type==='event'` `{type:'event', id, data: AgentEvent}` (`typesRaw.ts:291-294`) → normalized to `role:'event'` → reducer emits `kind:'agent-event'` (`ModeSwitchMessage`).

**Permission requests reach the UI two ways, both landing on `ToolCall.permission`** (there is no standalone `'permission'` Message kind):
1. ACP `permission-request` content item `{type:'permission-request', permissionId, toolName, description, options?}` (`typesRaw.ts:369-375`) is normalized **directly into a `tool-call`** whose `id === permissionId` (`typesRaw.ts:1163-1181`); resolved later by a matching `tool_result.permissions`.
2. **`AgentState.requests` / `completedRequests`** (`storageTypes.ts:113-131`) — a separate per-session encrypted state blob keyed by permission id. Reducer Phase 0 synthesizes tool-call messages from it (`reducer.ts:400-635`), so **a server can raise a pending permission prompt purely by syncing AgentState, with no chat message**. The record key must equal the tool id (reducer treats permission-id == tool-id, `reducer.ts:227`).

**Hard requirements for the app to render a server-produced message (silent-drop traps):**
- `role` must be exactly `'agent'|'user'|'session'` or the record is dropped (`typesRaw.ts:740-745`).
- `id`, `localId`, `createdAt` are **caller-assigned** (the sync/storage layer), not inside the encrypted `user`/`agent` RawRecord — our server must assign and keep them **stable across resyncs** (changing `id`, or `localId` for user msgs, duplicates the message; `createdAt` must never change — `reducer.ts:79-83`). `role:'session'` envelopes carry their own `id`/`time` which win.
- Agent assistant/user sub-records **require `data.uuid`** or they are dropped (`typesRaw.ts:786-788, 843-845`); this uuid is also the fork/rewind point.
- A `tool_result` must correlate its `tool_use_id` to a previously-seen tool call or the reducer no-ops it (`reducer.ts:817-880`).
- `data.type==='summary'` records are schema-valid but **currently dropped by the normalizer** (no branch handles them) — do not rely on `summary` RawRecords rendering.

### Permission requests (two paths)
1. Live/pending tool permissions surface on `AgentState.requests` — `Record<id, { tool, arguments, createdAt? }>` (`storageTypes.ts:115-119`); completed ones on `AgentState.completedRequests` with `status`/`decision`/`allowedTools`/`mode` (`:120-130`). Agent state is per-session encrypted.
2. The already-resolved permission also appears inline on `ToolCall.permission` in the flattened message (above).

An `ephemeral session-event` with `kind:'permission'` (`apiTypes.ts:216-223`) is the push/notification signal.

---

## Client operations the app performs (app → server)

Two transports carry app→server actions: **HTTP** for message send / lifecycle, and the single Socket.IO **`rpc-call`** (ack) event for everything interactive. Sending a message and creating a session are **not** in `ops.ts` — they live in `sync/sync.ts` and `ops.ts` respectively.

### Sending a user message (`sync.ts` — HTTP, not a socket emit)
`SyncManager.sendMessage` (`sync.ts:568`) builds a RawRecord `{ role:'user', content:{type:'text',text}, meta:{ sentFrom, appendSystemPrompt, permissionMode?, model?, effort?, displayText? } }`, encrypts it with `encryption.encryptRawRecord(content)` (base64), assigns `localId = randomUUID()`, queues it, and flushes via:
```
POST /v3/sessions/{sessionId}/messages
body: { messages: [ { localId, content } ] }         // content = base64 encrypted RawRecord
```
(`sync.ts:1814-1821`). Response `{ messages: [{ id, seq, localId, createdAt, updatedAt }] }` — **the server assigns the real `id`/`seq`/timestamps and echoes `localId`** for reconciliation. There is **no `new-message` socket emit from the app**; `new-message` is server→client only.

### Interactive RPC (`ops.ts` — socket `rpc-call` with ack)
All funnel through `apiSocket.sessionRPC` / `machineRPC` → `emitWithAck('rpc-call', { method:'<id>:<method>', params:<encrypted> })`, ack `{ ok:true, result:<encrypted> } | { ok:false, error? }`.

**Session RPC methods** (method = `` `${sessionId}:${m}` ``, params/result session-encrypted):
- `abort` `{reason}` (`ops.ts:559`), `permission` `{id, approved, mode, allowTools, decision, updatedInput?}` (approve `ops.ts:568` / deny `:576` — **same method, `approved` + `decision` differ**), `switch` `{to:'remote'|'local'}` (`:584`), `goal-action` `{action, objective?}` (`:597`), `bash` `{command, cwd?, timeout?}` (`:611`), `readFile` `{path}` (`:633`), `writeFile` `{path, content, expectedHash?}` (`:653`), `listDirectory` `{path}` (`:678`), `getDirectoryTree` `{path, maxDepth}` (`:698`), `ripgrep` `{args, cwd?}` (`:722`), `killSession` `{}` (`:746`).
- Session lifecycle over HTTP: `POST /v1/sessions/{id}/archive` (`ops.ts:766`), `DELETE /v1/sessions/{id}` (`:785`).

**Machine/daemon RPC methods** (method = `` `${machineId}:${m}` ``, params/result machine-encrypted):
- `spawn-happy-session` (`ops.ts:220`) — payload `{ type:'spawn-in-directory', directory, approvedNewDirectoryCreation?, token?, agent?:'claude'|'codex'|'gemini'|'openclaw', resumeClaudeSessionId?, resumeCodexThreadId?, parentSessionId?, forkedFromMessageId? }`; result `{type:'success', sessionId} | {type:'requestToApproveDirectoryCreation', directory} | {type:'error', errorMessage}`. **This is how the app tells a machine to start a session — the daemon/CLI mints the session + its `dataEncryptionKey`; the app never generates a session dataKey.**
- `resume-happy-session` `{sessionId, model?, permissionMode?}` (`:401`), `stop-daemon` `{}` (`:444`), `bash` `{command, cwd}` (`:456`, daemon shell), and fork/rewind helpers: `claude-fork-session`, `claude-list-rewind-points`, `claude-duplicate-session`, `codex-fork-thread`, `codex-duplicate-thread`, `codex-list-rewind-points` (`ops.ts:256-401`).
- Machine lifecycle: `DELETE /v1/machines/{id}` (`ops.ts:423`), `machine-update-metadata` via `emitWithAck` `{machineId, metadata:<encrypted>, expectedVersion}` (`:494`).

**Note on `dataKey` wrapping:** the generate-random-32-byte-key → `encryptEncryptionKey()` wrap → base64 pattern is used in this app only for **artifacts** (`sync.ts:1137-1158`). For **sessions** it is the machine/daemon that mints and wraps the per-session dataKey (server never sees plaintext). Our ai-or-die adapter therefore plays the daemon role: on `spawn-happy-session` it creates the session, generates a 32-byte dataKey, wraps it as `0x00 ‖ encryptBox(dataKey, contentPubKey)` and stores it as the session's `dataEncryptionKey`.

---

## Pairing (app side)

There are **two** distinct handshakes; both are pure client-side crypto and both hit HTTP endpoints under `getServerUrl()` (so they work against a custom server unchanged). Every request carries `X-Happy-Client: <platform>/<version>`.

### 0. Account auth (secret → token): `auth/authGetToken.ts` + `auth/authChallenge.ts`
- `authChallenge(secret)` (`authChallenge.ts:4-9`): `keypair = crypto_sign_seed_keypair(secret)` (Ed25519), random 32-byte `challenge`, `signature = crypto_sign_detached(challenge, privateKey)`. Returns `{ challenge, signature, publicKey }`.
- `authGetToken(secret)` (`authGetToken.ts:7-16`): `POST /v1/auth` with `{ challenge, signature, publicKey }` (all base64) → returns `{ token }`. **The account's identity public key = the Ed25519 pubkey derived from the master secret.**
- Restore flow (`app/(app)/restore/manual.tsx:74-108`): user pastes secret (base32 or base64url), `normalizeSecretKey` → 32 bytes → `authGetToken` → `auth.login(token, normalizedKey)`. `login` stores `{token, secret}` (`AuthContext.tsx:28-38`, `tokenStorage.ts`) and calls `syncCreate`.

### 1. Approving a **terminal/CLI** (app scans the CLI's QR): `hooks/useConnectTerminal.ts` + `auth/authApprove.ts`
This is the direction we care about most (our CLI/server presents a QR; the app approves it and hands over the key material).

- The QR / deep link is **`happy://terminal?<base64url terminalPublicKey>`** (`useConnectTerminal.ts:24,31`; web hash form `#key=…` → same URL, `terminal/connect.tsx:28-45`). The `<tail>` is a base64url **crypto_box public key** the CLI generated.
- On approve (`useConnectTerminal.ts:31-38`):
  ```ts
  const publicKey = decodeBase64(tail, 'base64url');
  const responseV1 = encryptBox(decodeBase64(secret, 'base64url'), publicKey);          // seals the 32-byte MASTER SECRET
  let responseV2Bundle = new Uint8Array(contentDataKey.length + 1);
  responseV2Bundle[0] = 0;                                                                // 0x00 version byte
  responseV2Bundle.set(sync.encryption.contentDataKey, 1);                                // 0x00 || contentDataKey(pubkey)
  const responseV2 = encryptBox(responseV2Bundle, publicKey);
  await authApprove(token, publicKey, responseV1, responseV2);
  ```
  `encryptBox(data, pub)` = `ephemeralPub(32) ‖ nonce(24) ‖ crypto_box_easy` sealed to the terminal's pubkey (`libsodium.ts:8-20`).
- `authApprove(token, publicKey, answerV1, answerV2)` (`auth/authApprove.ts:12-55`):
  1. `GET /v1/auth/request/status?publicKey=<b64>` → `{ status:'not_found'|'pending'|'authorized', supportsV2 }`.
  2. If `pending`: `POST /v1/auth/response` with `{ publicKey, response: supportsV2 ? b64(answerV2) : b64(answerV1) }`, `Authorization: Bearer <token>`.
- **V1 vs V2:** V1 shares the **full account master secret** with the terminal (terminal becomes a full account peer). V2 shares only `0x00 ‖ contentDataKey` — the content **public** key, enough to *wrap* data keys to the account but not the master secret. Our CLI must advertise `supportsV2` and consume whichever it gets.

### 2. Linking this app to an **existing account** (app generates key, waits): `auth/authQRStart.ts` + `auth/authQRWait.ts`
This is the app-is-the-new-device direction (another already-authed device approves *this* app).
- `generateAuthKeyPair()` (`authQRStart.ts:13-20`): random 32-byte seed → `crypto_box_seed_keypair` → `{publicKey, secretKey}`.
- `authQRStart(keypair)` (`authQRStart.ts:22-49`): `POST /v1/auth/account/request` with `{ publicKey: b64 }`.
- `authQRWait(keypair, …)` (`authQRWait.ts:13-60`): polls `POST /v1/auth/account/request` (same body) every 1s until `response.data.state === 'authorized'`, then:
  ```ts
  const token = response.data.token;
  const decrypted = decryptBox(decodeBase64(response.data.response), keypair.secretKey); // the sealed master secret
  return { secret: decrypted, token };
  ```
  i.e. the approver seals the **master secret** to this app's ephemeral pubkey; app opens it with its secretKey and now has `{secret, token}`.
- `authAccountApprove(token, publicKey, answer)` (`auth/authAccountApprove.ts:6-16`) is the approver side: `POST /v1/auth/account/response` with `{ publicKey, response: b64(answer) }`.

### Secret backup format (`auth/secretKeyBackup.ts`)
32-byte secret ↔ human string via **base32 (RFC4648 alphabet, no padding)** grouped `XXXXX-XXXXX-…` (11 groups) (`:12-33, 81-102`). Parser normalizes confusables `0→O 1→I 8→B 9→G` and strips non-alphabet chars (`:35-74`). `normalizeSecretKey` accepts either base32-formatted or base64url and returns base64url (`:158-179`).

### Credential storage (`auth/tokenStorage.ts`)
`AuthCredentials { token: string; secret: string }` (secret is base64url). Native → `expo-secure-store` key `auth_credentials`; web → `localStorage` (`tokenStorage.ts:4,14-59`).

---

## Push

`sync/pushRegistration.ts` + `sync/apiPush.ts`. Expo push, native only (web returns `unsupported`).
- Token: `Notifications.getExpoPushTokenAsync({ projectId })` where `projectId` = EAS project id from the Expo manifest (`pushRegistration.ts:52-54,116-138,182-183`). **This is an Expo push token bound to Happy's EAS project id — a third-party server cannot mint or reroute these; they only work through Expo's push service for the Happy app build.**
- Register: `POST /v1/push-tokens` `{ token }`, headers `Authorization: Bearer`, `Content-Type: application/json`, `X-Happy-Client` (`apiPush.ts:20-42`). Expects `{ success: true }`.
- List: `GET /v1/push-tokens` → `{ tokens: [{id,token,createdAt,updatedAt}] }` (`apiPush.ts:44-63`).
- Unregister: `DELETE /v1/push-tokens/<urlencoded token>` → `{ success:true }` (`apiPush.ts:65-86`). Called on logout (`AuthContext.tsx:42-49`).
- All wrapped in `backoff(...)` retry.

### appState reporting (push routing)
- Handshake includes `appState` (`apiSocket.ts:94`). The server uses live focus state to suppress pushes when the app is foregrounded; the app emits `app-state` `{ state }` on change (`apiSocket.ts:187-189`). `getCurrentAppState()` computes `'active'|'background'` from `AppState` (mobile) or `document.visibilityState && hasFocus()` (web) (`:23-33`).

---

## Integration notes for ai-or-die (the client-imposed contract)

To drive/monitor our sessions from the **unmodified** Happy app, our server (or an adapter in front of it) must satisfy all of the following. This is what the app *forces* on us.

### A. Make the app point at us (no rebuild)
1. User opens Settings → Server, types our URL, hits Save.
2. **Our `GET /` (root, `Accept: text/plain`) MUST return 200 with a body containing the exact string `Welcome to Happy Server!`** (`server.tsx:105`), else the app refuses the URL. Cheapest path: serve that string at root.
3. URL must be `http:`/`https:` and parseable (`serverConfig.ts:72`). That's the only other constraint. No port/path restriction.
4. (Web/desktop only) alternatively inject `globalThis.__HAPPY_CONFIG__.serverUrl` or set `EXPO_PUBLIC_HAPPY_SERVER_URL` at build — but for the stock app the Settings path is the real seam.

### B. Socket.IO endpoint
- Mount a **Socket.IO v4** server at **path `/v1/updates`**, accept **websocket transport** (no polling), and read the handshake `auth` = `{ token, clientType:'user-scoped', happyClient, appState }`. Authenticate `token` (from our `/v1/auth`). Keep infinite reconnection working (idempotent auth).
- Only **two** server→client events reach the app: **`update`** and **`ephemeral`**. The `update` envelope must be `{ id, seq, body:{ t, … }, createdAt }` (`apiTypes.ts:169-174`) and `body.t` one of the `ApiUpdateSchema` literals (`new-message`, `new-session`, `update-session`, `update-account`, `new-machine`, `update-machine`, `new-artifact`, …). **Field-name traps:** `new-message`/`delete-session` key the session by **`sid`**, but `update-session` keys by **`id`**. `kv-batch-update` (update) and `usage` (ephemeral) validate but are silently ignored — don't rely on them.
- `ephemeral` shapes the app acts on: `activity {id,active,activeAt,thinking}`, `machine-activity {id,active,activeAt}`, `session-event {sessionId,kind,title,body,timestamp}`.
- Support `rpc-call` (ack) for app→session/machine RPC: ack `{ ok:true, result:<encrypted> }` or `{ ok:false, error }`. `method` arrives as `` `${targetId}:${realMethod}` `` and `params` is our-encrypted (session/machine encryptor). The app **initiates** all RPC; the server never RPCs the app.

### C. Auth / pairing (pick one UX)
The app already knows how to obtain a token from a secret (`/v1/auth` challenge) and to pair a terminal (`happy://terminal?<pub>` → `/v1/auth/request/status` + `/v1/auth/response`). Options for us:
- **(Preferred) Reuse the terminal-pairing flow:** our CLI/server generates a crypto_box keypair, renders `happy://terminal?<base64url pub>` as a QR; the user scans it in the app; the app POSTs `/v1/auth/response` with `response = 0x00‖contentDataKey` (V2) or the master secret (V1) sealed to our pubkey. We must implement `GET /v1/auth/request/status` and `POST /v1/auth/response`, and advertise `supportsV2`. With V2 we get `contentDataKey` (the account content **public** key) → enough to wrap per-session data keys to the account; the app decrypts them via its private half. With V1 we get the master secret outright.
- **(Simplest for a self-hosted single-user server) Provision the secret directly:** generate a 32-byte master secret server-side, hand the user the base32 backup string, they paste it into Restore. Then implement `/v1/auth` (verify the Ed25519 challenge signature against the derived pubkey, return a token). We then hold the master secret and can derive every key ourselves.
- Either way we must implement `POST /v1/auth` (challenge/signature/publicKey → `{token}`) because the app calls it on every restore/login.

### D. Encryption our server MUST produce/accept (byte-for-byte)
- **Master secret** = 32 bytes; the app decodes `credentials.secret` as **base64url**.
- **Key tree** = HMAC-SHA-512 BIP32-style (`deriveKey.ts`): root `HMAC(key=seed, "<usage> Master Seed")`, child `HMAC(key=chainCode, 0x00‖index)`, split 32/32. Reproduce `contentDataKey = deriveKey(master,'Happy EnCoder',['content'])`, blob keys `deriveKey(dataKey,'Happy Blobs',['session'])` / `deriveKey(master,'Happy Blobs',['master'])`.
- **Per-session message/metadata/state content (modern):** base64( **`0x00` ‖ AES-256-GCM(IV12 ‖ ct ‖ tag16)** ), plaintext = UTF-8 of `JSON.stringify(payload)`, key = the session's 32-byte `dataKey`, no AAD (`encryptor.ts:90-125`, `aes.web.ts`). Deliver encrypted message content as `content:{ t:'encrypted', c:<that base64> }`.
- **Legacy content (null dataKey):** base64( `nonce24` ‖ `crypto_secretbox_easy(JSON)` ), key = master secret, **no version byte** (`libsodium.ts:36-57`). Prefer the modern per-session path.
- **Wrapping a per-session dataKey (the `dataEncryptionKey` field):** `0x00` ‖ `encryptBox(dataKey, contentPublicKey)` where `encryptBox` = `ephemeralPub32 ‖ nonce24 ‖ crypto_box_easy`, sealed to the account's `contentDataKey` public key (`encryption.ts:217-224`, `libsodium.ts:8-20`). The app unwraps with `decryptEncryptionKey` (requires the `0x00` byte).
- **Artifacts:** AES-256-GCM with a random 32-byte per-artifact key, that key wrapped as above; header/body each encrypted separately (`artifactEncryption.ts`).
- **Blobs (attachments):** NaCl secretbox `nonce24 ‖ crypto_secretbox` (`encryption/blob.ts`), key = derived session blob key.

### E. Message content the app expects (to render our Claude sessions)
Decrypted message content is a `RawRecord`; `normalizeRawMessage` turns it into the `Message` union. The app renders these kinds: `user-text`, `agent-text`, `tool-call` (with `permission` for tool approvals), `agent-event` (`typesMessage.ts`). For our ai-or-die Claude output we emit Claude-Code-shaped RawRecords: `{ role:'agent', content:{ type:'output', data:{ type:'assistant', message:{ role:'assistant', model, content:[ {type:'text'|'tool_use'|'thinking', …} ], usage? }, uuid, parentUuid } } }`, with tool results as follow-up `{type:'tool_result', tool_use_id, content, permissions?}` items. **`data.uuid` is mandatory** (missing → silently dropped) and doubles as the fork/rewind point. We also set session `metadata` (path/host/models per `MetadataSchema`) and `agentState.requests`/`completedRequests` for permission prompts. **The message `id`/`localId`/`createdAt` are assigned by our sync/storage layer (NOT inside the encrypted RawRecord) and must be stable across resyncs; `createdAt` must never change.** Full RawRecord field shapes are in "Raw record & normalization detail".

- **Delivering a message** to the app: over the socket as a `new-message` `update`, and/or on the `GET /v3/sessions/{id}/messages` fetch, as an `ApiMessage` whose `content = { t:'encrypted', c:<base64 of our AES-GCM blob> }`.
- **Receiving a message** from the app: `POST /v3/sessions/{id}/messages` `{ messages:[{ localId, content }] }` where `content` is the app's base64-encrypted `{role:'user',content:{type:'text',text},meta}` RawRecord. Respond `{ messages:[{ id, seq, localId, createdAt, updatedAt }] }`.
- **Spawning / driving a session**: the app calls `spawn-happy-session` (machine RPC) to start one, then interactive control (`bash`, `readFile`, `permission`, `abort`, `switch`, …) via session RPC over `rpc-call`. Our adapter must implement the machine/session RPC surface it wants to support and mint+wrap the session `dataEncryptionKey` daemon-side.

### F. Push
- Push only reaches native app builds via Expo's push service bound to **Happy's own EAS project id** — a custom server can store/forward Expo push tokens (`/v1/push-tokens`) and *send* pushes through Expo's API using those tokens, but cannot mint them. Live/foreground suppression relies on the socket `appState`/`app-state` signal (implement it, or just accept pushes may fire while foregrounded). If we skip push, in-app real-time still works entirely over the socket.

### G. Endpoints the stock app calls (must exist on our server)
Confirmed from the app source (base = `getServerUrl()`, all with `Authorization: Bearer` + `X-Happy-Client` unless noted):
- `GET /` → body containing `Welcome to Happy Server!` (unauth, server-validation probe; `server.tsx:105`).
- `POST /v1/auth` — `{challenge, signature, publicKey}` (base64) → `{token}` (unauth; `authGetToken.ts`).
- `GET /v1/auth/request/status?publicKey=` , `POST /v1/auth/response` `{publicKey, response}` — terminal/CLI approve (`authApprove.ts`).
- `POST /v1/auth/account/request` `{publicKey}` , `POST /v1/auth/account/response` `{publicKey, response}` — account link (`authQRStart/Wait`, `authAccountApprove.ts`).
- **Socket.IO at path `/v1/updates`** (events `update`, `ephemeral`; app emits `rpc-call`, `app-state`).
- `GET /v1/sessions` , `POST /v1/sessions/{id}/archive` , `DELETE /v1/sessions/{id}`.
- `GET /v1/machines` (bare array) , `DELETE /v1/machines/{id}`.
- `GET/POST /v1/account/settings` , `GET /v1/account/profile` , `POST /v1/version`.
- **`GET /v3/sessions/{id}/messages?before_seq=&after_seq=&limit=`** and **`POST /v3/sessions/{id}/messages`** `{messages:[{localId,content}]}` — note the **`/v3`** prefix for messages.
- `GET/POST /v1/push-tokens` , `DELETE /v1/push-tokens/{t}`.
- `GET/POST /v1/kv` , `GET /v1/kv/{key}` , `POST /v1/kv/bulk` (`apiKv.ts`; not called by `sync.ts` itself).
- `GET/POST /v1/artifacts` , `GET/POST/DELETE /v1/artifacts/{id}` (`apiArtifacts.ts`).
