# happy-wire — canonical wire protocol

> Source study of `packages/happy-wire` in the Happy monorepo clone at
> `C:\Users\anikundu\AppData\Local\Temp\happy-study` (HEAD `d2ef88d`), read-only.
> Every claim is cited `packages/happy-wire/src/<file>:<line>` (wire package) or a
> consumer path where the wire package is silent. This is the contract reference for
> making ai-or-die speak Happy's wire protocol.

---

## Package purpose & consumers

`@slopus/happy-wire` is the single source of truth for Happy's wire schemas — TypeScript types + Zod v4 schemas, "intentionally small and focused on protocol-level data only" (`packages/happy-wire/README.md:5`). It exists to kill schema drift: before it, "wire-level message and session-protocol schemas were duplicated across packages (CLI, app, server, and agent)" (`docs/happy-wire.md:7`).

- Name / version: `@slopus/happy-wire` `0.1.0` (`packages/happy-wire/package.json:2-3`).
- Runtime deps: `zod ^4.0.0`, `@paralleldrive/cuid2 ^2.2.2` (`packages/happy-wire/package.json:38-41`).
- ESM+CJS+types library built with `pkgroll` (`package.json:11-25,33`).
- Consumers declare `^0.1.0` and consume it as a versioned dependency (`docs/happy-wire.md:15-16,75-77`):
  - **CLI** (`packages/happy-cli`): `src/sessionProtocol/types.ts` re-exports from it; `src/api/types.ts` sources message/update schemas from it (`docs/happy-wire.md:50-54`).
  - **App** (`packages/happy-app`): `sources/sync/apiTypes.ts` imports `ApiMessageSchema`, `ApiUpdateNewMessageSchema`, `ApiUpdateSessionStateSchema`, `ApiUpdateMachineStateSchema` (`docs/happy-wire.md:56-63`).
  - **Server** (`packages/happy-server`): Prisma JSON content type + event router use `SessionMessageContent` (`docs/happy-wire.md:64-68`).
  - **Agent** (`packages/happy-agent`): `RawMessage` aliases `SessionMessage` (`docs/happy-wire.md:69-72`).

> ⚠️ **Reality check for integration:** the app does NOT actually validate inbound records with the wire package. `packages/happy-app/sources/sync/typesRaw.ts` carries its OWN duplicate copy of the session schemas (`typesRaw.ts:34-135`) plus a normalization layer (`typesRaw.ts:385-458`). The wire package is the *declared* contract; the app's `typesRaw.ts` is the *enforced* read-path contract, and the two shapes differ (see "Two protocol generations" → app-shape mismatch). Target the app's accepted shape, not just the wire package's schema.

---

## File map

| File | LOC | Role |
|---|---|---|
| `src/index.ts` | 4 | Barrel; re-exports `messages`, `legacyProtocol`, `sessionProtocol`, `voice` (`index.ts:1-4`). **Note:** does NOT re-export `messageMeta` (it is re-exported transitively via `messages.ts:21-22`). |
| `src/messages.ts` | 114 | Sync/update envelopes (`CoreUpdateContainer`), encrypted message container (`SessionMessage`), top-level decrypted `MessageContent` union, versioned-value schemas, migration aliases. |
| `src/legacyProtocol.ts` | 28 | Legacy decrypted payloads: `UserMessage` / `AgentMessage` and their `role`-union. **The active production path.** |
| `src/sessionProtocol.ts` | 157 | Newer `SessionEnvelope` + 9-variant `SessionEvent` union + `createEnvelope()` helper. **Frozen / "under review."** |
| `src/messageMeta.ts` | 15 | `MessageMetaSchema` shared by both generations. |
| `src/voice.ts` | 37 | ElevenLabs voice grant/usage response schemas (HTTP, not the chat wire). |
| `src/messages.test.ts` | 234 | Round-trip parse tests for update/message/union schemas. |
| `src/sessionProtocol.test.ts` | 154 | Envelope/event validity + `superRefine` role rules + `createEnvelope`. |
| `README.md` | 741 | Full narrative spec (mirrors code; normative examples). |

Repo-level narrative docs: `docs/happy-wire.md` (package rationale), `docs/session-protocol.md` (the 9-event stream design + ACP comparison), `docs/session-protocol-claude.md` (how the CLI maps Claude JSONL → envelopes), `docs/encryption.md` (framing of the encrypted `c`/`value` blobs), `docs/protocol.md` (Socket.IO transport + all update/ephemeral event types).

---

## Schemas (grouped, quoted, with file:line)

### Group A — Update / sync envelope (`messages.ts`)

The server→client persistent sync unit. Delivered over Socket.IO as the `update` event (`docs/protocol.md:54-63`).

**`CoreUpdateContainerSchema`** — the outer sync record (`messages.ts:88-94`):

```ts
export const CoreUpdateContainerSchema = z.object({
  id: z.string(),
  seq: z.number(),
  body: CoreUpdateBodySchema,
  createdAt: z.number(),
});
```

**`CoreUpdateBodySchema`** — discriminated union on `t`, exactly 3 variants (`messages.ts:81-86`):

```ts
export const CoreUpdateBodySchema = z.discriminatedUnion('t', [
  UpdateNewMessageBodySchema,
  UpdateSessionBodySchema,
  UpdateMachineBodySchema,
]);
```

**`UpdateNewMessageBodySchema`** (`messages.ts:50-55`):

```ts
export const UpdateNewMessageBodySchema = z.object({
  t: z.literal('new-message'),
  sid: z.string(),
  message: SessionMessageSchema,
});
```

**`UpdateSessionBodySchema`** (`messages.ts:57-63`):

```ts
export const UpdateSessionBodySchema = z.object({
  t: z.literal('update-session'),
  id: z.string(),
  metadata: VersionedEncryptedValueSchema.nullish(),
  agentState: VersionedNullableEncryptedValueSchema.nullish(),
});
```

**`UpdateMachineBodySchema`** (`messages.ts:71-79`):

```ts
export const UpdateMachineBodySchema = z.object({
  t: z.literal('update-machine'),
  machineId: z.string(),
  metadata: VersionedMachineEncryptedValueSchema.nullish(),
  daemonState: VersionedMachineEncryptedValueSchema.nullish(),
  active: z.boolean().optional(),
  activeAt: z.number().optional(),
});
```

> The wire package covers only these 3 update bodies. The **server actually emits ~15** update types (`new-session`, `delete-session`, `update-account`, `new-machine`, `new-artifact`, `update-artifact`, `delete-artifact`, `relationship-updated`, `new-feed-post`, `kv-batch-update`, …) per `docs/protocol.md:74-116`. The wire package is a *subset* — the 3 that all four consumers agreed to share. Anything else is defined only in consumer packages.

Versioned-value building blocks:

**`VersionedEncryptedValueSchema`** — value non-null (`messages.ts:38-42`):

```ts
export const VersionedEncryptedValueSchema = z.object({
  version: z.number(),
  value: z.string(),
});
```

**`VersionedNullableEncryptedValueSchema`** — value may be null (reset) (`messages.ts:44-48`):

```ts
export const VersionedNullableEncryptedValueSchema = z.object({
  version: z.number(),
  value: z.string().nullable(),
});
```

**`VersionedMachineEncryptedValueSchema`** — identical shape to the non-null one, kept separate for machine updates (`messages.ts:65-69`):

```ts
export const VersionedMachineEncryptedValueSchema = z.object({
  version: z.number(),
  value: z.string(),
});
```

### Group B — Encrypted message container (`messages.ts`)

**`SessionMessageContentSchema`** — the encrypted blob wrapper stored/synced for every message (`messages.ts:6-10`):

```ts
export const SessionMessageContentSchema = z.object({
  c: z.string(),
  t: z.literal('encrypted'),
});
```

- `t` is always `'encrypted'`; `c` is the base64 ciphertext (`README.md:225-227`, `docs/encryption.md:352-355`).

**`SessionMessageSchema`** — the DB-row-shaped message (`messages.ts:12-19`):

```ts
export const SessionMessageSchema = z.object({
  id: z.string(),
  seq: z.number(),
  localId: z.string().nullish(),
  content: SessionMessageContentSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
```

- `localId` is `.nullish()` (undefined | null | string) for producer compatibility (`README.md:243`).

### Group C — Ephemeral events

**Not in the wire package.** Ephemeral presence/usage events (`activity`, `machine-activity`, `usage`, `machine-status`) are defined only in `docs/protocol.md:118-122` and consumer code. They are transient, un-sequenced, and never encrypted. The wire package deliberately scopes to persistent, sequenced, encrypted payloads. Shapes (from `docs/protocol.md:118-122`, for reference):

```
activity:         { type: "activity", id: sessionId, active, activeAt, thinking? }
machine-activity: { type: "machine-activity", id: machineId, active, activeAt }
usage:            { type: "usage", id: sessionId, key, tokens, cost, timestamp }
machine-status:   { type: "machine-status", machineId, online, timestamp }
```

### Group D — Message / record content (decrypted payloads)

These are the shapes that live *inside* the decrypted `c` blob.

**Legacy — `UserMessageSchema`** (`legacyProtocol.ts:4-12`):

```ts
export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  localKey: z.string().optional(),
  meta: MessageMetaSchema.optional(),
});
```

**Legacy — `AgentMessageSchema`** (`legacyProtocol.ts:15-23`) — note the `.passthrough()`, which makes agent content deliberately open-ended (any `type` string + arbitrary extra keys):

```ts
export const AgentMessageSchema = z.object({
  role: z.literal('agent'),
  content: z
    .object({
      type: z.string(),
    })
    .passthrough(),
  meta: MessageMetaSchema.optional(),
});
```

**Legacy union — `LegacyMessageContentSchema`** (`legacyProtocol.ts:26-27`):

```ts
export const LegacyMessageContentSchema = z.discriminatedUnion('role', [UserMessageSchema, AgentMessageSchema]);
```

**Modern wrapper — `SessionProtocolMessageSchema`** (`messages.ts:24-29`) — the decrypted payload that carries a session-protocol envelope:

```ts
export const SessionProtocolMessageSchema = z.object({
  role: z.literal('session'),
  content: sessionEnvelopeSchema,   // <-- envelope DIRECTLY under content
  meta: MessageMetaSchema.optional(),
});
```

**Top-level decrypted union — `MessageContentSchema`** (`messages.ts:31-36`) — the discriminator that unifies both generations:

```ts
export const MessageContentSchema = z.discriminatedUnion('role', [
  UserMessageSchema,           // role: 'user'    (legacy)
  AgentMessageSchema,          // role: 'agent'   (legacy)
  SessionProtocolMessageSchema // role: 'session' (modern)
]);
```

> This is the schema every decrypted `c` blob is expected to satisfy. `role ∈ {user, agent, session}` is the top-level discriminator. See the app-shape mismatch note below — the app's enforced version of the `session` branch is nested differently.

### Group E — Session-protocol `SessionEnvelope` + `SessionEvent` union (`sessionProtocol.ts`)

**`sessionRoleSchema`** — envelope-internal role, only 2 values (`sessionProtocol.ts:18`):

```ts
export const sessionRoleSchema = z.enum(['user', 'agent']);
```

**`SessionEvent` union** — discriminated on `t`, **9 variants** (`sessionProtocol.ts:82-92`):

```ts
export const sessionEventSchema = z.discriminatedUnion('t', [
  sessionTextEventSchema,             // t: 'text'
  sessionServiceMessageEventSchema,   // t: 'service'
  sessionToolCallStartEventSchema,    // t: 'tool-call-start'
  sessionToolCallEndEventSchema,      // t: 'tool-call-end'
  sessionFileEventSchema,             // t: 'file'
  sessionTurnStartEventSchema,        // t: 'turn-start'
  sessionStartEventSchema,            // t: 'start'
  sessionTurnEndEventSchema,          // t: 'turn-end'
  sessionStopEventSchema,             // t: 'stop'
]);
```

The 9 event shapes (`sessionProtocol.ts:21-80`):

```ts
// 1) text                                       (sessionProtocol.ts:21-25)
{ t: 'text', text: string, thinking?: boolean }
// 2) service                                    (sessionProtocol.ts:27-30)
{ t: 'service', text: string }
// 3) tool-call-start                            (sessionProtocol.ts:32-39)
{ t: 'tool-call-start', call: string, name: string, title: string,
  description: string, args: Record<string, unknown> }
// 4) tool-call-end                              (sessionProtocol.ts:41-44)
{ t: 'tool-call-end', call: string }
// 5) file                                       (sessionProtocol.ts:46-59)
{ t: 'file', ref: string, name: string, size: number, mimeType?: string,
  image?: { width: number, height: number, thumbhash: string } }
// 6) turn-start                                 (sessionProtocol.ts:61-63)
{ t: 'turn-start' }
// 7) start                                      (sessionProtocol.ts:65-68)
{ t: 'start', title?: string }
// 8) turn-end                                   (sessionProtocol.ts:73-76)
{ t: 'turn-end', status: 'completed' | 'failed' | 'cancelled' }
// 9) stop                                       (sessionProtocol.ts:78-80)
{ t: 'stop' }
```

> Discrepancy vs README: the README's `file` example (`README.md:466-480`) OMITS `mimeType`, but the code has `mimeType: z.string().optional()` (`sessionProtocol.ts:51`) and the test uses it (`sessionProtocol.test.ts:25,31`). Also note `image` requires ALL of `width`/`height`/`thumbhash` when present (`sessionProtocol.ts:52-58`) — a test rejects `image` missing `thumbhash` (`sessionProtocol.test.ts:48`). The app's own copy, by contrast, makes `thumbhash` optional (`packages/happy-app/sources/sync/typesRaw.ts:59-73`) — another wire-vs-app divergence.

**`sessionTurnEndStatusSchema`** (`sessionProtocol.ts:70`):

```ts
export const sessionTurnEndStatusSchema = z.enum(['completed', 'failed', 'cancelled']);
```

**`sessionEnvelopeSchema`** — the envelope, with a `superRefine` cross-field rule (`sessionProtocol.ts:96-132`):

```ts
export const sessionEnvelopeSchema = z
  .object({
    id: z.string(),
    time: z.number(),
    role: sessionRoleSchema,                    // 'user' | 'agent'
    turn: z.string().optional(),
    subagent: z.string()
      .refine((value) => isCuid(value), { message: 'subagent must be a cuid2 value' })
      .optional(),
    claudeUuid: z.string().min(1).optional(),   // Claude's session-JSONL uuid; rewind point
    codexItemId: z.string().min(1).optional(),  // Codex app-server item id; rollback point
    ev: sessionEventSchema,
  })
  .superRefine((envelope, ctx) => {
    if (envelope.ev.t === 'service' && envelope.role !== 'agent') { /* addIssue */ }
    if ((envelope.ev.t === 'start' || envelope.ev.t === 'stop') && envelope.role !== 'agent') { /* addIssue */ }
  });
```

`superRefine` rules (`sessionProtocol.ts:117-131`; tests `sessionProtocol.test.ts:81-101`):
- `ev.t === 'service'` ⇒ `role` MUST be `'agent'`.
- `ev.t === 'start'` or `'stop'` ⇒ `role` MUST be `'agent'`.
- `subagent`, when present, MUST pass `isCuid()` (cuid2) — provider tool ids like `toolu_*` are rejected (`sessionProtocol.test.ts:103-113`). Docs stress provider-native ids "must not be used as `subagent` values" (`docs/session-protocol.md:68`).
- Envelope internal `role` is never `'session'` — a `role: 'session'` envelope is rejected (`sessionProtocol.test.ts:71-79`). `'session'` lives only on the OUTER wrapper.

**`createEnvelope(role, ev, opts?)` helper** (`sessionProtocol.ts:136-156`):

```ts
export type CreateEnvelopeOptions = {
  id?: string; time?: number; turn?: string; subagent?: string;
  claudeUuid?: string; codexItemId?: string;
};

export function createEnvelope(role, ev, opts = {}): SessionEnvelope {
  return sessionEnvelopeSchema.parse({
    id: opts.id ?? createId(),          // cuid2
    time: opts.time ?? Date.now(),      // epoch ms
    role,
    ...(opts.turn ? { turn: opts.turn } : {}),
    ...(opts.subagent ? { subagent: opts.subagent } : {}),
    ...(opts.claudeUuid ? { claudeUuid: opts.claudeUuid } : {}),
    ...(opts.codexItemId ? { codexItemId: opts.codexItemId } : {}),
    ev,
  });
}
```

- Defaults `id` to a fresh cuid2 and `time` to `Date.now()`; omits optional keys entirely when absent; `.parse()` throws on invalid role/event combos (`sessionProtocol.test.ts:116-153`).

### Group F — Metadata / agentState / machine (client-side, encrypted)

The wire package defines the **versioned encrypted wrappers** (Group A) but NOT the plaintext shapes inside them — those are documented in `docs/encryption.md` and defined in `packages/happy-cli/src/api/types.ts` (`docs/encryption.md:348-452`). Reference shapes:
- **Session metadata** plaintext: `{ path, host, homeDir, happyHomeDir, version, name, os, machineId, claudeSessionId, tools[], slashCommands[], startedBy, lifecycleState, flavor, ... }` (`docs/encryption.md:379-405`).
- **Agent state** plaintext: `{ controlledByUser, requests{}, completedRequests{} }`, where completed requests carry `mode`/`decision`/`allowTools` (`docs/encryption.md:407-428`).
- **Machine metadata** / **daemon state** plaintext (`docs/encryption.md:430-452`).

These matter for ai-or-die's session-creation/metadata emission but are NOT enforced by happy-wire; treat `docs/encryption.md` as the spec.

### Group G — `messageMeta.ts`

**`MessageMetaSchema`** — optional per-message metadata attached to both legacy and modern payloads (`messageMeta.ts:3-13`):

```ts
export const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo']).optional(),
  model: z.string().nullable().optional(),
  fallbackModel: z.string().nullable().optional(),
  customSystemPrompt: z.string().nullable().optional(),
  appendSystemPrompt: z.string().nullable().optional(),
  allowedTools: z.array(z.string()).nullable().optional(),
  disallowedTools: z.array(z.string()).nullable().optional(),
  displayText: z.string().optional(),
});
```

- `sentFrom` observed values in tests/code: `'mobile'`, `'cli'` (`messages.test.ts:132,150`; CLI sets `'cli'` at `apiSession.ts:786`).

### Group H — `voice.ts` (ElevenLabs; HTTP responses, not chat wire)

These are server HTTP responses for the paid voice feature, not part of the encrypted message stream.

**`VoiceConversationResponseSchema`** — union on `allowed` (`voice.ts:21-24`):

```ts
export const VoiceConversationResponseSchema = z.discriminatedUnion('allowed', [
  VoiceConversationGrantedSchema,  // allowed: true
  VoiceConversationDeniedSchema,   // allowed: false
]);
```

Granted (`voice.ts:3-11`): `{ allowed: true, conversationToken, conversationId, agentId, elevenUserId, usedSeconds, limitSeconds }`.
Denied (`voice.ts:13-19`): `{ allowed: false, reason: 'voice_hard_limit_reached'|'subscription_required'|'voice_conversation_limit_reached', usedSeconds, limitSeconds, agentId }`.
**`VoiceUsageResponseSchema`** (`voice.ts:28-34`): `{ usedSeconds, limitSeconds, conversationCount, conversationLimit, elevenUserId }`.

### Migration aliases (`messages.ts:96-113`)

Kept so existing consumers don't break during migration:

```ts
ApiMessageSchema             = SessionMessageSchema;          // messages.ts:97
ApiUpdateNewMessageSchema    = UpdateNewMessageBodySchema;    // messages.ts:100
ApiUpdateSessionStateSchema  = UpdateSessionBodySchema;       // messages.ts:103
ApiUpdateMachineStateSchema  = UpdateMachineBodySchema;       // messages.ts:106
UpdateBodySchema             = UpdateNewMessageBodySchema;    // messages.ts:109
UpdateSchema                 = CoreUpdateContainerSchema;     // messages.ts:112
```

---

## Two protocol generations

The package holds **two coexisting generations of the decrypted message payload**, unified at the top by `MessageContentSchema`'s `role` discriminator (`messages.ts:31-36`).

### Generation 1 — Legacy (`role: 'user'` / `role: 'agent'`) — **PRIMARY / ACTIVE**

Defined in `legacyProtocol.ts`. The `sessionProtocol.ts` header is explicit that legacy is the live path:

```text
The legacy protocol (role: 'user' / role: 'agent') is the active code path everywhere.
                                            — sessionProtocol.ts:5-6
```

`docs/happy-wire.md:24` confirms legacy schemas are "used for encrypted message/update contracts." Agent content is intentionally loose (`type: z.string()` + `.passthrough()`, `legacyProtocol.ts:15-23`), so historical `output`/`codex`/`acp`/`event` content types all validate. The CLI still emits legacy-shaped agent messages for Codex/ACP (`packages/happy-cli/src/api/apiSession.ts:767-778,814-825`).

### Generation 2 — Session protocol (`role: 'session'` wrapper + `SessionEnvelope`) — **FROZEN / "UNDER REVIEW"**

Defined in `sessionProtocol.ts` and wrapped by `SessionProtocolMessageSchema` (`messages.ts:24-29`). The file header freezes it:

```text
⚠️ UNDER REVIEW — LIKELY NEEDS MORE CAREFUL DESIGN

This session protocol is not used in production and should NOT be used in dev
environments either until we revisit the design. ...
Before investing more here, look at how pi.dev standardizes their agent
protocol — we may want to align with or build on that approach instead of
rolling our own envelope format.
Types are kept here for reference but are frozen. Do not add new consumers.
                                            — sessionProtocol.ts:1-13
```

`docs/session-protocol.md:3` frames it as the intended future: "Old sessions continue using legacy formats; new sessions use this protocol exclusively" — but the wire-package header (newer) supersedes that aspiration and marks it frozen/not-in-production.

### How the two relate (adapters)

- **Top-level union.** `MessageContentSchema` (`messages.ts:31-36`) is the only adapter *inside* the package: `role` selects legacy user, legacy agent, or the modern session wrapper. There is no bidirectional legacy⇄session converter in happy-wire.
- **CLI mapper (external).** The legacy→session translation lives in the CLI, not the wire package: `packages/happy-cli/src/claude/utils/sessionProtocolMapper.ts` maps Claude JSONL → envelopes; `apiSession.ts` sends them (`docs/session-protocol-claude.md:12-22,88-111`). During migration the CLI emits BOTH legacy `user:text` AND a `session:text` "shadow copy" for user plain strings (`docs/session-protocol-claude.md:98`).
- **⚠️ App-shape mismatch (the load-bearing ambiguity for integration).** The wire package's modern wrapper puts the envelope DIRECTLY under `content`:

  ```ts
  // happy-wire — SessionProtocolMessageSchema (messages.ts:24-29)
  { role: 'session', content: <SessionEnvelope>, meta? }
  ```

  and the CLI sender matches that flat shape (`apiSession.ts:781-791`: `content: envelope`). But the APP's enforced read schema nests the envelope under `content.data` behind a second `type: 'session'` discriminator:

  ```ts
  // happy-app — rawRecordSchema, session branch (typesRaw.ts:449-456)
  { role: 'session', content: { type: 'session', data: <SessionEnvelope> }, meta? }
  ```

  The app reconciles this with a **preprocessor** (`typesRaw.ts:413-428`) that detects the flat wire shape (`content.type !== 'session' && content.id && content.role && content.ev`) and up-converts it to the nested canonical form before validation. The app also EMITS the nested shape directly for its own outbound file events (`packages/happy-app/sources/sync/sync.ts:635-664`). Net: **both shapes are accepted on the read path**, but the flat happy-wire shape is what a source should emit, and the app's preprocessor is what makes it work. Emit the flat shape (matches CLI + wire package); the app normalizes.

---

## Discriminators & enums

| Discriminator | Where | Full value set |
|---|---|---|
| `t` (update body) | `CoreUpdateBodySchema` `messages.ts:81-86` | `'new-message'`, `'update-session'`, `'update-machine'` (wire subset; server has ~15 total, `docs/protocol.md:74-116`) |
| `t` (message content) | `SessionMessageContentSchema` `messages.ts:6-10` | `'encrypted'` (only value) |
| `role` (top-level decrypted) | `MessageContentSchema` `messages.ts:31-36` | `'user'`, `'agent'`, `'session'` |
| `role` (legacy union) | `LegacyMessageContentSchema` `legacyProtocol.ts:26` | `'user'`, `'agent'` |
| `role` (envelope-internal) | `sessionRoleSchema` `sessionProtocol.ts:18` | `'user'`, `'agent'` (never `'session'`) |
| `t` (session event) | `sessionEventSchema` `sessionProtocol.ts:82-92` | `'text'`, `'service'`, `'tool-call-start'`, `'tool-call-end'`, `'file'`, `'turn-start'`, `'start'`, `'turn-end'`, `'stop'` (9) |
| `status` (turn-end) | `sessionTurnEndStatusSchema` `sessionProtocol.ts:70` | `'completed'`, `'failed'`, `'cancelled'` |
| `permissionMode` | `MessageMetaSchema` `messageMeta.ts:5` | `'default'`, `'acceptEdits'`, `'bypassPermissions'`, `'plan'`, `'read-only'`, `'safe-yolo'`, `'yolo'` |
| `type` (legacy user content) | `UserMessageSchema` `legacyProtocol.ts:6-9` | `'text'` (only value) |
| `type` (legacy agent content) | `AgentMessageSchema` `legacyProtocol.ts:18-21` | open `z.string()` + `.passthrough()` (observed: `output`, `codex`, `acp`, `event`) |
| `allowed` (voice) | `VoiceConversationResponseSchema` `voice.ts:21-24` | `true`, `false` |
| `reason` (voice denied) | `VoiceConversationDeniedSchema` `voice.ts:15` | `'voice_hard_limit_reached'`, `'subscription_required'`, `'voice_conversation_limit_reached'` |
| `kind` | — | **No `kind` discriminator exists anywhere in the package.** |

> Field-key note: the package uses terse keys deliberately — `t` (type), `sid` (session id), `id`, `seq`, `c` (ciphertext), `ev` (event) — "stable because they are used across clients" (`docs/protocol.md:14`).

---

## Versioning

**Two independent version concepts.** Do not conflate them.

1. **Package (semver).** `@slopus/happy-wire` `0.1.0` (`package.json:3`); consumers pin `^0.1.0` (`docs/happy-wire.md:16`). Change policy (`README.md:715-721`): prefer additive changes; treat discriminator `t` values as "protocol-level API"; avoid breaking renames; bump the package before downstream releases. No protocol-version field is carried on the wire itself — the wire is versioned only through this npm semver + additive discipline. Backward-compat over breaking changes is a stated protocol motivation (`docs/protocol.md:19`).

2. **Per-field payload `version` (optimistic concurrency, NOT protocol version).** The `version: z.number()` inside `VersionedEncryptedValueSchema` / `VersionedNullableEncryptedValueSchema` / `VersionedMachineEncryptedValueSchema` (`messages.ts:38-69`) is a monotonic per-field counter for CAS-style updates. Writers send `expectedVersion`; the server returns `version-mismatch` with the current version on conflict (`docs/protocol.md:127-133,196-199`). It exists for metadata/agentState/daemonState — it is not a schema version.

3. **`seq` (ordering, not versioning).** `UpdatePayload.seq` is the per-user monotonic sync counter (`docs/protocol.md:16,197`); `SessionMessage.seq` orders messages within a session (`messages.ts:14`). Apply-in-order gives consistency.

There is **no wire-format version byte or magic number in this package.** The only version byte in the whole system is inside the ENCRYPTION framing (below), which happy-wire does not touch.

---

## Encryption framing (referenced here, defined elsewhere)

happy-wire only sees the *outside* of encryption: the string fields `c` (`SessionMessageContentSchema.c`, `messages.ts:7`) and `value` (the versioned wrappers, `messages.ts:40,46,67`) are opaque base64 ciphertext. The actual framing (from `docs/encryption.md`, implemented in `packages/happy-cli/src/api/encryption.ts`):

- **Two variants, chosen by whether a `dataKey` exists** (`docs/encryption.md:64-105`):
  - **Legacy NaCl secretbox** (XSalsa20-Poly1305): layout `[ nonce(24) | ciphertext+auth ]`, 32-byte shared key. **No version byte.** (`docs/encryption.md:66-82`)
  - **dataKey AES-256-GCM**: layout `[ version(1) | nonce(12) | ciphertext | authTag(16) ]`, **`version` currently `0`** (`docs/encryption.md:84-106`).
- **DataKey bundle framing** (`tweetnacl.box`): `[ ephPublicKey(32) | nonce(24) | ciphertext ]`, then wrapped `[ version(1 = 0) | boxBundle ]`, base64-encoded into `dataEncryptionKey` fields (`docs/encryption.md:132-155`).
- **All encrypted bytes → base64 on the wire; timestamps/ids/versions stay plain** (`docs/encryption.md:520-543`).
- Encryption is end-to-end; the server is blind and stores `{ t: 'encrypted', c: '<base64>' }` verbatim (`docs/encryption.md:216-226`).

So the byte-level version (`0`) is per-message crypto framing, entirely separate from the package semver and the per-field `version` counter.

---

## Integration notes for ai-or-die

**Which generation to target: LEGACY (`role: 'user'` / `role: 'agent'`).** It is the active production path everywhere (`sessionProtocol.ts:5-6`); the session-protocol generation is frozen and "not used in production… do not add new consumers" (`sessionProtocol.ts:4,12`). The app's read path enforces its own `typesRaw.ts` copy, and legacy agent content is `.passthrough()` (`legacyProtocol.ts:15-23`), so it is the most forgiving and lowest-risk surface to emit. (If we want the richer tool-call/turn UI, we can *additionally* emit the session generation as a shadow copy the way the CLI does — but legacy alone renders in the app.)

### Minimal must-emit set to be seen as a valid session source

We are a *source* (a session/message producer). To appear as a live Happy session driven from the Happy iOS app, ai-or-die must, in order:

1. **Auth + create a session (HTTP + Socket.IO).** `POST /v1/sessions` with `{ tag, metadata: <base64-encrypted>, agentState: <base64-encrypted|null>, dataEncryptionKey: <bundle|null> }` (`docs/encryption.md:263-274`), then connect Socket.IO at path `/v1/updates` with `auth: { token, clientType: 'session-scoped'|'user-scoped', sessionId }` (`docs/protocol.md:28-45`). *These envelopes are NOT in happy-wire — they are server contracts in `docs/encryption.md` / `docs/protocol.md` / `docs/api.md`.*

2. **Encrypt every payload** with the shared key (legacy NaCl secretbox is the simplest: `[ nonce(24) | ciphertext ]`, base64) — `docs/encryption.md:66-82`. Server never decrypts.

3. **Emit messages via Socket.IO `message` event**: `{ sid, message: '<base64-encrypted>', localId? }` (`docs/protocol.md:135-138`, `docs/encryption.md:276-285`). The server wraps the ciphertext into `SessionMessageContentSchema` `{ t: 'encrypted', c }` (`messages.ts:6-10`) and fans it out to the app as a `new-message` update.

4. **The decrypted plaintext inside `message` must satisfy `MessageContentSchema`** (`messages.ts:31-36`). Minimum viable set:

   - **Agent output (what the phone shows as Claude's reply)** — `AgentMessageSchema` (`legacyProtocol.ts:15-23`). Loosest schema; `content.type` is any string. Simplest valid shape:
     ```json
     { "role": "agent", "content": { "type": "text", "text": "..." }, "meta": { "sentFrom": "cli" } }
     ```
     (For fidelity, match what the app renders — the app expects legacy agent content like `{ type: 'output', data: {...} }` per `docs/encryption.md:370-377` and normalizes via `typesRaw.ts`. Confirm the exact app-rendered agent content shape against `packages/happy-app/sources/sync/typesRaw.ts` before finalizing.)

   - **User echo (messages typed on the phone come back)** — `UserMessageSchema` (`legacyProtocol.ts:4-12`):
     ```json
     { "role": "user", "content": { "type": "text", "text": "..." }, "meta": { "sentFrom": "mobile" } }
     ```

5. **Keep the session alive / show activity (ephemeral):** emit `session-alive` `{ sid, time, thinking? }` (`docs/protocol.md:139-142`) so the app shows the session as active/thinking. Not encrypted, not in happy-wire.

6. **Consume inbound `new-message` updates** (`CoreUpdateContainerSchema` → `UpdateNewMessageBodySchema`, `messages.ts:50-55,88-94`): decrypt `message.content.c`, parse against `MessageContentSchema`, and feed `role: 'user'` messages (typed on the phone) into our Claude session as input. This closes the drive loop.

### The must-emit happy-wire schemas (the actual contract surface)

| Direction | Schema (happy-wire) | Why |
|---|---|---|
| We emit (encrypted plaintext) | `UserMessageSchema` `legacyProtocol.ts:4-12` | user echo |
| We emit (encrypted plaintext) | `AgentMessageSchema` `legacyProtocol.ts:15-23` | Claude output — the primary payload |
| We emit (optional) | `MessageMetaSchema` `messageMeta.ts:3-13` | `sentFrom`, `model`, `permissionMode` |
| We consume | `CoreUpdateContainerSchema` `messages.ts:88-94` | server sync frames |
| We consume | `UpdateNewMessageBodySchema` `messages.ts:50-55` | inbound phone messages |
| Both (opaque) | `SessionMessageContentSchema` `messages.ts:6-10` | `{ t:'encrypted', c }` container |
| Validate everything decrypted | `MessageContentSchema` `messages.ts:31-36` | top-level `role` union |

### Ambiguities / gotchas to design around

- **happy-wire ≠ enforced app contract.** The app validates with its own `packages/happy-app/sources/sync/typesRaw.ts`, not `@slopus/happy-wire`. Test emitted payloads against `typesRaw.ts` (and against a real app build), not just against the wire package. This is the biggest integration risk.
- **Session-generation shape mismatch** (`SessionProtocolMessageSchema` flat `content: envelope` vs app's nested `content: { type:'session', data: envelope }`, reconciled by the app preprocessor `typesRaw.ts:413-428`). If we ever emit the session generation, emit the FLAT wire shape and rely on the preprocessor. But default to legacy and sidestep this entirely.
- **`file.mimeType` and `image.thumbhash` differ between wire and app copies** (`sessionProtocol.ts:51`/`52-58` vs `typesRaw.ts:59-73`). Only relevant if we adopt the session generation.
- **The wire package is a subset of the real server protocol.** Session creation, auth, `session-alive`, ephemeral activity, and ~12 other update types are NOT in happy-wire; they live in `docs/protocol.md` / `docs/encryption.md` / `docs/api.md` and the server package. Budget those as separate contracts to implement.
- **cuid2 requirement** applies only to session-generation `id`/`turn`/`subagent` (`sessionProtocol.ts:104,111`). Legacy messages have no such constraint — `id`/`seq` are server-assigned on `SessionMessage`.
- **Encryption is the real gate, not the schema.** Getting the NaCl/AES framing + key exchange right (`docs/encryption.md`) is where the integration effort actually is; the JSON shapes above are trivial once the crypto matches.
