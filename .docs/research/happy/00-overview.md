# Happy Coder ↔ ai-or-die — research overview

**What:** feasibility study for driving/monitoring our **ai-or-die** Claude Code instances from the **existing** [Happy Coder](https://github.com/slopus/happy) iOS/iPad app, without forking or owning the app.

**Clone studied:** `slopus/happy` monorepo, HEAD `d2ef88d` (2026-07-02), cloned to a disposable temp folder. This is a pnpm monorepo; the formerly-separate `slopus/happy-cli` and `slopus/happy-server` repos were archived and merged here.

**Verdict up front: feasible, and the project is explicitly built for it.** The unmodified Happy app ships a **custom-server-URL** setting (no rebuild), the relay is a bounded store-and-fan-out surface (~12 REST routes + ~8 socket events over opaque E2E blobs), and the server already ships a single-command, dependency-free standalone. The real work is reproducing Happy's **encryption + pairing** byte-for-byte and mapping our control-plane state onto Happy's wire shapes.

**Recommended path (after cross-lab review — see `90-integration-synergies.md`):** run Happy's own **standalone relay as a supervised sidecar** (ai-or-die already supervises the mesh and keepalive sidecars) and write only the ai-or-die→Happy **producer adapter**. The relay's Socket.IO/Engine.IO + per-account sequencing correctness is the easy-to-break part — let Happy own it. Validate the adapter against the **real installed iOS app** on Windows before deciding whether to ever reimplement the relay natively.

## Per-part reference docs (this folder)
| Doc | Package / source | What it covers |
|---|---|---|
| `10-happy-wire.md` | `packages/happy-wire` | Canonical Zod wire schemas — the JSON contract. **Target the legacy `role:'user'/'agent'` generation** (SessionEnvelope v2 is frozen). |
| `20-happy-server.md` | `packages/happy-server` | Relay HTTP + Socket.IO surface, auth/token minting, Prisma model, seq/CAS, and the PGlite standalone / self-host plan. |
| `30-happy-cli.md` | `packages/happy-cli` | The **producer** ai-or-die emulates: ordered wire lifecycle, Claude wrapping (official agent-SDK `query()` + `canUseTool`), v3 HTTP messages, dataKey crypto. |
| `40-happy-app-sync-crypto-auth.md` | `packages/happy-app` (sync/encryption/auth) | **Client-imposed constraints**: the custom-server seam + `Welcome to Happy Server!` gate, exact crypto framing the app will decrypt, socket handshake, pairing from the app side, push. |
| `50-happy-agent-and-docs.md` | `packages/happy-agent` + repo `docs/` | The ~9-file **minimal producer** reference, plus an architecture narrative and roadmap signals (protocol churn vs stability). |

## How the pieces fit (mental model)
```
  [Happy iOS/iPad app]  ──Socket.IO /v1/updates + REST /v1,/v3──►  [happy-server relay]
        (holds the                                                  (dumb store + fan-out;
         private key;                                                only sees opaque
         decrypts locally)                                           ciphertext + routing meta)
                                                                            ▲
                                                                            │ same protocol
                                                                            │
                                                            [happy-cli / happy-agent = PRODUCER]
                                                            (wraps Claude, encrypts, registers
                                                             machine+session, streams output up,
                                                             receives input/permission down)
```
- **The app never talks to the dev machine directly** — everything is relayed. The relay is untrusted (E2E-encrypted); self-hosting it changes nothing about the security model.
- **ai-or-die's job** is to occupy the **producer** role (the happy-cli/happy-agent box), and — depending on strategy — either point the app at Happy's own standalone relay, or *also* occupy the **relay** box natively. See the strategy comparison in `90`.

## Core models at a glance (see per-part docs for citations)
- **Identity:** public-key accounts. `POST /v1/auth` with an Ed25519 `{publicKey, challenge, signature}` upserts an account keyed by pubkey and mints an opaque bearer token (privacy-kit persistent token seeded by `HANDY_MASTER_SECRET`; **not** JWT). No email/password. The app auto-authenticates when pointed at a new server.
- **Pairing (content key delivery):** ephemeral X25519 box handshake. The producer shows a QR (`happy://terminal?<b64url ephemeralPub>`); the already-authenticated app seals its content secret to that pubkey and POSTs `/v1/auth/response`; the producer polls `/v1/auth/request` and unseals. **The app's private key never leaves the app.**
- **Sync:** per-user monotonic `seq` (gap-detect/resync) + per-entity `expectedVersion` CAS on every mutating write.
- **Realtime:** Socket.IO at path `/v1/updates`, websocket transport, two server→client emits that matter — `update {id,seq,body:{t,...},createdAt}` (14-member `body.t` union) and `ephemeral` (presence/usage). Messages are **sent** via `POST /v3/sessions/:id/messages` (batch, seq-paginated), not a socket emit.
- **Encryption:** legacy = NaCl `secretbox` (XSalsa20-Poly1305, `nonce24 ‖ ct`, key = shared master secret — **symmetric**); modern "dataKey" = AES-256-GCM (`0x00 ‖ iv12 ‖ ct ‖ tag16`, per-session key wrapped to the account pubkey via `crypto_box`). Key tree = BIP32-style HMAC-SHA-512. Reproducible with `tweetnacl` + Node `crypto`; no native libsodium needed producer-side.
- **Push:** Expo push tokens (bound to Happy's EAS projectId), registered via `POST /v1/push-tokens`; a server sends by forwarding to Expo's push API. Foreground realtime needs no push.

## Key caveats surfaced by the study
1. **Protocol is pre-1.0 and churning at the message-envelope layer** (two conflicting, unshipped v2 drafts). Transport/identity/crypto/sync are stable; the inner message shape is not. → emit **legacy behind a mapper**, and **verify the on-wire shape empirically** against a real app build (the app validates with its *own* copy of the types in `sync/typesRaw.ts`, not the npm `happy-wire` package).
2. **The hardest single thing** is byte-exact crypto/pairing; one wrong framing byte and the app silently drops the session. Legacy shared-secret mode is far simpler than dataKey and is the right MVP target.
3. **Push notifications** depend on Expo tokens tied to Happy's project — forwardable but to be validated empirically.
