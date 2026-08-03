# Integration synergies — ai-or-die → Happy app

Goal: let an unmodified **Happy iOS/iPad app** view and drive our **ai-or-die** Claude Code sessions. This doc cross-maps Happy's wire contract (docs `10`–`50`) onto ai-or-die's surfaces, compares strategies, and recommends a path + MVP. **Revised after cross-lab adversarial review (codex-critic gpt-5.5 + gemini-critic) — see §7.**

---

## 1. The central synergy: ai-or-die already produces almost everything Happy wants

Happy's producer (happy-cli) does three things ai-or-die **already does**, which is why this is a good fit rather than a rewrite:

| Happy producer needs… | ai-or-die already has… | Source |
|---|---|---|
| Claude output as **transcript-shaped JSON lines** (`type`, `uuid`, `parentUuid`, `cwd`, `gitBranch`, `sessionId`) — happy-cli synthesizes these via `SDKToLogConverter` | The **real Claude JSONL transcript on disk**, bound per session via `_stickyJsonl` (`AIORDIE_CLAUDE_BIND` sidecar → claude sessionId + path), tailed by `readNewTurns()` | `30-happy-cli.md`; `src/sticky-note-jsonl.js`, `src/server.js` `_stickyJsonl` |
| Semantic **session status** (busy / waiting-on-permission / idle) | `deriveStatus()` + `jsonl-awaiting.js` (detects ExitPlanMode / AskUserQuestion / tool-permission) | `src/control/session-status.js`, `src/control/jsonl-awaiting.js` |
| **Input injection** + **stop** + **spawn** | `POST /api/control/sessions/:id/{message,keys,respond,stop,create}` | `src/control/routes.js` |
| An **event stream** to know when to push | `ControlEventBus` (`turn_ended`, `became_idle/busy`, `waiting_input`, `exited`, …) | `src/control/event-bus.js` |
| Off-LAN **reachability** | **Mesh** Tailscale `tsnet` → `https://<host>.ts.net` | `src/mesh-manager.js`, `mesh/main.go` |

**The unavoidable new work is a "producer adapter"**: Claude JSONL line → Happy legacy `RawRecord` → encrypt → `POST /v3/sessions/:id/messages`; Happy inbound user text → `POST /api/control/sessions/:id/message`; permission mapping; pairing/crypto. This adapter is required in **every** strategy below.

---

## 2. Field-level mapping (Happy wire ↔ ai-or-die)

| Happy concept | Happy shape | ai-or-die source | Notes |
|---|---|---|---|
| **Machine** (required, see §7) | `POST /v1/machines {id, metadata:enc}` + machine-scoped socket + `machine-alive` + `rpc-register` spawn/stop | one per ai-or-die instance; stable UUID | RPCs → `POST /api/control/sessions/create`,`/:id/stop` |
| **Session** | `POST /v1/sessions {tag, metadata:enc, agentState:enc}` | one per claude session; `tag`=ai-or-die session UUID (idempotent) | `metadata.path`=workingDir, `.claudeSessionId`=from `_stickyJsonl`, `.summary.text`=autoTitle |
| **Agent message** | legacy `RawRecord {role:'agent', content:{type:'output', data:<transcript line>}}` via `POST /v3/.../messages` | each new turn from `readNewTurns()` | `data.uuid` mandatory, **valid UUIDv4**, stable across resyncs → use the transcript's own uuid |
| **User message** | inbound `update{t:'new-message'}` → decrypt → `{role:'user', content:{type:'text', text}}` | `POST /api/control/sessions/:id/message` | single source of truth = JSONL echo; de-dupe by claude uuid (§7-8) |
| **Thinking/activity** | `session-alive {thinking,mode}` + `ephemeral{type:'activity'}` | `deriveStatus().interactionState`; `became_busy/idle` | spinner/presence |
| **Permission** | `AgentState.requests[id]={tool,arguments,createdAt}` via `update-state` **+ scoped `permission` RPC** | `jsonl-awaiting`/`deriveStatus().awaiting`; resolve → `/respond {choice}` **+ clear request** | highest-fidelity risk (§7-3) |
| **Title** | `metadata.summary.text` via `update-metadata` | `autoTitle`/`stickyNote` | already generated |
| **Lifecycle end** | `session-end` + `POST /v1/sessions/:id/archive` | `exited`/`crashed` | |
| **Ordering** | per-**account** monotonic `seq` (`allocateUserSeq`) + per-entity `expectedVersion` CAS | new: durable sequencer (§7-4) | |

---

## 3. Strategy comparison (post-review)

In all strategies ai-or-die writes the **producer adapter** (§1); they differ only in who runs the **relay** (the Socket.IO/Engine.IO + seq/CAS + store server the app talks to).

### S1a — Supervise Happy's own **standalone relay** as a sidecar  ⟵ recommended shipping target
Run `happy-server`'s single-command PGlite standalone (no Postgres/Redis) as a child process — exactly the pattern ai-or-die already uses for the **mesh Go sidecar** and the **keepalive helper**. ai-or-die's producer adapter connects to it; the app points at the standalone's origin.
- **Pros:** Happy owns the two hardest-to-reimplement invariants — **Engine.IO/Socket.IO semantics** and **durable seq/CAS/store** — so we can't get them subtly wrong; tracks upstream protocol churn automatically; the "supervise a sidecar" shape is already idiomatic in ai-or-die.
- **Cons:** a second Node runtime + PGlite bundled/shipped; a pre-1.0 vendored codebase; reachability plumbing to expose its origin over the mesh (§5).

### S2 — ai-or-die implements the minimal relay **natively**, in-process
Add the bounded Happy surface (~12 REST routes + a real `socket.io` server at `/v1/updates` + v3 messages) to ai-or-die, single-tenant, reusing its store.
- **Pros:** one process; own auth + mesh origin + control-plane event bus; no vendored server; no PGlite.
- **Cons:** **must correctly reimplement Engine.IO/Socket.IO + durable per-account seq/CAS + machine/session liveness** — precisely the invariants the review flagged as easy to break silently. Higher long-term correctness burden under a churning protocol.

### S1b — Full `happy-server` (Docker/Postgres/Redis) — **not recommended** (heaviest, no single-user benefit).

### Recommendation
**Prototype against S1a immediately** (fastest path to "one ai-or-die session live on the phone"): run Happy's standalone + our minimal producer adapter, and prove crypto + pairing + uplink + downlink + one permission against the **real installed iOS app**. That single spike de-risks the entire producer adapter — which is common to every strategy — against a known-correct relay. **Then choose the shipping relay** (S1a supervised sidecar vs S2 native) based on whether the second-process weight or the reimplementation-under-churn risk is more acceptable to you. The spike's producer-adapter code is ~100% reusable either way.

## 3b. Multi-instance / fleet: do we need a relay?

**Yes, if one app should reach several ai-or-die instances without re-pairing/re-pointing each time.** The app is **single-endpoint** — `getServerUrl()` returns one base URL (one MMKV `custom-server-url`), one Socket.IO connection to `<that>/v1/updates`; it never multiplexes server URLs (`packages/happy-app/sources/sync/serverConfig.ts`). But within one server it shows **many machines and many sessions** under one account (account-scoped discovery + user-scoped socket streaming `new-machine`/`new-session`). So fan-out must happen server-side. Two shapes:

- **A) One shared relay (recommended for multi-instance).** Each instance runs the producer adapter and dials **outbound** to a single relay, registering as its own **machine**; the phone points at that one relay and sees all instances together. Only the relay needs to be reachable by the phone (valid TLS) — **instances behind NAT/firewalls work with no inbound exposure**, which is the relay's core value. One pairing, one identity. Maps onto ai-or-die's mesh: a hub (the PGlite standalone, or one always-on instance) that every mesh peer dials into.
- **B) No relay, switch in turn.** Each instance runs its own embedded relay at its own URL (e.g. its mesh `.ts.net`); to use another you change the app's server URL and re-pair. No central infra, but every instance must be directly reachable, each is a separate account/pairing, only one is visible at a time, and switching is manual.

**Implication for the strategy split:** the multi-instance goal *favors the relay (S1a/hub) end-state* over per-instance native relays (S2). The spike is unchanged — one relay + one adapter is the exact unit; multi-instance just runs the adapter on each instance against the same relay.

**Verified (source audit + empirical, HEAD d2ef88d):**
- **The app remembers all paired instances — because the relay is the memory.** The app holds the machine/session list only in memory (Zustand); local MMKV persists *preferences only*. On every launch/reconnect it re-fetches the full list via `GET /v1/machines` + `GET /v1/sessions` (`sources/sync/sync.ts`, `apiSocket.onReconnected → invalidate`). `POST /v1/machines` is get-or-create by `id` (deduped, `@@unique([accountId,id])`), and `new-machine` merges into the store. So every instance ever paired reappears on every launch, from anywhere — durable because *our* relay (PGlite) persists it; the app is a stateless view.
- **Empirical:** two producers under one account (distinct `machineId`s) → one user-scoped mock-app connection saw **2 machines + 2 sessions, 4 msgs decrypted from each, no cross-wiring** (`happy-adapter-spike/two-instance-test.sh` → `TWO_INSTANCE PASS`).
- **View/drive is airtight** — `message` fan-out is strictly `sid`-scoped (`eventRouter.getRoomsForFilter` unions only the session room + user-scoped room; never broadcasts). Multiple adapters never cross-wire.
- **Rough edges (not blockers for view/drive):** machine-level RPC (spawn/stop) has a ~15s reconnect-grace race and a 30s cap (long ops "not supported"); no client-side per-account `seq` gap detection (recovers by full refetch on reconnect, not incrementally); liveness is connection-based (`isMachineOnline = machine.active`), so our adapter shows "online" by just holding the socket — no real daemon needed — but a silent drop can look alive for up to ~10 min.
- **Relay detail:** session identity is get-or-create by `tag`, so each session needs a **unique tag** (a fresh UUID per session — the intended usage; repeating a tag collapses to one session). And our relay must return real HTTP errors (not empty `200`) on transient failures, or the app's "keep last good on empty fetch" guard can mask a genuine deletion.


---

## 4. Crypto & pairing (corrected after review — MVP = legacy shared-secret)

**The content secret is app-owned; ai-or-die does NOT choose it.** Verified in `packages/happy-app/sources/hooks/useConnectTerminal.ts` + `auth/authApprove.ts`:
```js
// app side, on scanning our QR (happy://terminal?<b64url ephemeralPub>):
const responseV1 = encryptBox(decodeBase64(auth.credentials.secret, 'base64url'), ourEphemeralPub); // seals the app's OWN secret
// responseV2 seals 0x00 ‖ contentDataKey (the account's PUBLIC key)
authApprove(token, ourEphemeralPub, responseV1, responseV2); // sends responseV1 iff server /v1/auth/request/status returns supportsV2:false
```
Consequences for ai-or-die:
- **We control the mode.** Our relay's `GET /v1/auth/request/status` returns `supportsV2:false` → the app sends the **legacy** answer (its own 32-byte master secret, sealed to our ephemeral X25519 pubkey). We `tweetnacl.box.open` it with our ephemeral secret → the app's master secret.
- **Legacy is symmetric and correct for producer-originated content**: encrypt everything as `base64(nonce24 ‖ crypto_secretbox(JSON.stringify(payload), appSecret))`; the app decrypts with the same secret. (Why dataKey/v2 exists: forward secrecy + multi-writer safety — not needed for single-user self-host.)
- **Nonce rules (review CRIT):** use `randombytes(24)` per message — **never a counter** (restart → nonce reuse → catastrophic secretbox break). *No version-byte collision risk:* the app selects legacy vs dataKey by whether the session carries a `dataEncryptionKey` (`null ⇒ legacy secretbox`), not by sniffing ciphertext bytes — verified `packages/happy-app/sources/sync/encryption/encryption.ts:57-61,91`. So a legacy session's blobs are always opened with `secretbox`; leading-`0x00` nonces are fine.
- **Auth:** implement `POST /v1/auth` (verify Ed25519 challenge/signature, upsert account by pubkey, mint an opaque bearer token). The app auto-calls this on a new server.
- **Defer dataKey/AES-GCM** until legacy is proven end-to-end.

---

## 5. Transport, TLS/ATS & the `Welcome to Happy Server!` gate
- **iOS ATS requires valid TLS (review CRIT).** No self-signed certs (would need a manually installed Root CA — violates "unmodified/zero-friction"). Use **Tailscale's Let's Encrypt cert** (`tailscale cert` / tsnet `GetCertificate`) on the relay's origin, and the **phone must be on the tailnet** (MagicDNS resolves `<host>.ts.net`; off-tailnet = silent DNS failure). Confirm ai-or-die's mesh serves a real cert (the sidecar emits a `MESH-NOCERT` signal — cert provisioning must be ON for this).
- **Port/mesh wrinkle:** the mesh currently reverse-proxies the tailnet listener → ai-or-die's main port, whose `GET /` serves ai-or-die's UI. Happy needs an origin whose `GET /` returns the literal `Welcome to Happy Server!`. So the Happy relay needs its **own origin** — either a second tsnet listener/port the mesh also proxies (a small mesh change) or a second mesh hostname. Must also pass the **websocket upgrade** through the proxy and open the **Windows firewall** for Node on the Tailscale interface.
- **LAN (confirmed OK for plaintext):** the **production** App Store build sets `NSAppTransportSecurity: { NSAllowsLocalNetworking: true }` (`packages/happy-app/app.config.js:86-88`), so the phone can hit `http://<lan-ip>:<port>` on a private/LAN address with **no TLS**. Valid TLS is only required for off-LAN/public origins (Tailscale `.ts.net` or Cloudflare give it).

### Phone connectivity options (private-in-mesh vs. no-VPN-on-phone is a genuine tradeoff)
"Relay stays tailnet-private" and "phone connects without Tailscale" are mutually exclusive — pick per context. Note Tailscale on iOS is **split-tunnel by default** (only `100.x`/`*.ts.net` traffic is carried; not a phone-wide VPN unless an exit node is set).
- **A. `tailscale serve`** — phone on tailnet (split-tunnel, toggleable). Relay stays fully private, zero public exposure, valid `.ts.net` cert. Max privacy.
- **B. `tailscale funnel <port>`** — phone needs **no** Tailscale. One command publishes just that port to the public internet at `https://<host>.<tailnet>.ts.net` with a Let's Encrypt cert and **WebSocket/`wss` support** (verified). The relay is then a *public* endpoint, but bounded: E2E hides content, the `ALLOWED_ACCOUNT_PUBKEYS` allowlist blocks stranger registration, and funnel is on/off per port. **This is the "no VPN on the phone" answer.**
- **C. Cloudflare Tunnel** — same public-but-gated posture on your own domain + WAF.
- **D. LAN-only** — same Wi-Fi, `http://<lan-ip>:<port>`, no VPN, no exposure. Zero friction at home.

## 5b. Securing a publicly-reachable relay
The relay is **untrusted by design** (E2E: it holds only ciphertext + routing metadata), so the threat model is **access/abuse, not confidentiality**. Two real risks: open account registration (`POST /v1/auth` upserts by pubkey) and DoS.
- **Cloudflare Access / Google-OAuth-at-the-edge is incompatible with the unmodified app.** The app is a native Socket.IO + `Bearer` client with no browser/cookies; it cannot complete an interactive OAuth challenge or send Access service-token headers, so Access on `/v1/*`,`/v3/*`,`/v1/updates` returns 403 to the app. Not a trust issue — a protocol one.
- **Recommended — Tailscale-only.** Expose the relay only inside the tailnet (`https://<host>.ts.net`, valid Let's Encrypt cert, ATS-clean); gate = tailnet membership, which can use **Google as Tailscale's SSO** — so Google gatekeeps at the network/device layer (where the app works) instead of the HTTP layer (where it doesn't). Reuses ai-or-die's mesh; phone needs the Tailscale app once.
- **Alternative — Cloudflare Tunnel** for a public custom domain: use it for exposure + TLS + WAF/rate-limiting only; access control = happy-server Bearer auth **+ a public-key allowlist** locking the relay to your account(s) (add `ALLOWED_ACCOUNT_PUBKEYS`; standalone is open-registration today, matching the self-host plan's "single-user, first pairing wins" intent). Never put Access/OAuth on the API paths.

**Verified by app source audit (not just inferred):** the app has **no** embedded Tailscale/VPN/NetworkExtension/P2P and **no direct-to-machine mode** — it connects to exactly one server URL over HTTP(S) (`sources/app/(app)/server.tsx`, `sync/serverConfig.ts`; only a custom-URL field gated by the `Welcome to Happy Server!` string). WebRTC/LiveKit in the app is **voice-only**, not a transport. There is **no certificate pinning and no host allowlist** in the app, so a device that is on a tailnet reaches `https://<host>.ts.net` transparently at the OS layer with zero app cooperation — Tailscale "just works" as the private transport, and the relay need never be internet-facing. There is also no app-level lock/biometric; device security is the OS's job.


---

## 6. MVP slice (smallest thing that proves it — run against S1a standalone)
1. Point the app at the standalone origin (serves the welcome string; valid TLS via mesh).
2. Pairing: ai-or-die shows the QR; app seals its secret (legacy, `supportsV2:false`); adapter unseals.
3. `POST /v1/machines` (one machine) + machine-scoped socket + `machine-alive` + `rpc-register` spawn/stop.
4. `POST /v1/sessions` (tag=session UUID) + session-scoped socket + `session-alive`.
5. **Uplink:** tail bound JSONL (`_stickyJsonl` + `readNewTurns`, complete lines only) → legacy `RawRecord` (transcript's own uuid) → encrypt → `POST /v3/.../messages`. ✅ conversation renders on the phone.
6. **Downlink:** app message → inbound `update{t:'new-message'}` → decrypt → `POST /api/control/sessions/:id/message`; the echo returns via the JSONL tail (de-duped by uuid). ✅ drive works.
7. **Permission:** publish `AgentState.requests[id]` (id derived from the JSONL `tool_use` id, not screen position); register the `permission` RPC; on approve → `/respond {choice}` **and immediately clear the request** via `update-state`. ✅ no hang.
Success criterion: all of the above verified against the **real installed iOS app**, on **Windows** (ConPTY prompt parsing), surviving one relay+adapter restart without message loss/dupes.

---

## 7. Risks & review findings (must-address, ranked)
1. **Content-secret direction (was wrong in draft; now fixed §4).** App-owned via pairing; `supportsV2:false` forces legacy. *Resolved by source read.*
2. **Relay must speak Engine.IO/Socket.IO, not raw ws (codex CRIT-2).** Reuse of ai-or-die's terminal ws is impossible. → strongest argument for S1a; if S2, add the real `socket.io` server.
3. **Permission lifecycle = RPC + clear AgentState (codex CRIT-3, gemini CRIT-2).** Register the scoped `permission` RPC so the app's tap resolves; broadcast a *cleared* `AgentState.requests` the moment awaiting-detection sees the modal gone (real PTY claude emits no "approved" event). Use a **stable request id** (JSONL `tool_use` id). MVP: only the modals ai-or-die reliably detects; document the gap. **Windows prompt-parsing** (ConPTY/CRLF/ANSI) must be tested (codex #14).
4. **Durable seq/token/secret state (codex CRIT-4/#10, gemini CRIT-1).** Persist across restart: app pubkey, bearer token, app content secret, machine id, session `tag→id`, per-**account** `seq` high-water, and transcript-uuid→emitted map. Atomic sequencer. **Never re-emit** on restart (dupes) and never reset seq below the app's known max (silent drops). Don't conflate `update.seq` / v3-pagination seq / transcript uuid.
5. **Machine role non-optional (codex CRIT-5, gemini IMPORTANT).** Without `POST /v1/machines` + machine socket + liveness, sessions may not list / may show offline / input disabled / permission RPC unavailable. Implement at least a "fake machine" (codex #12).
6. **Empirical conformance is against the real iOS app, not the standalone (codex #6/#13).** The app validates with its own `sync/typesRaw.ts`; HEAD `d2ef88d` may differ from the App-Store/TestFlight binary. Byte-capture from the standalone = schema discovery, **not** a compatibility proof.
7. **User-message durability/echo (codex #8).** Downlink only injects to PTY; rely on the JSONL echo as the single source of truth, de-duped by claude uuid — don't also append a separate producer copy (dupes) and mind the pre-write gap (transient).
8. **Partial-line tailing (codex #9).** Emit only complete JSONL lines (buffer partial/UTF-8); `data.uuid` must pass the app's UUIDv4 regex or the whole record is silently dropped.
9. **Reachability (codex #11, gemini CRIT-3).** Valid cert on the relay port, phone on tailnet, websocket upgrade through the proxy, Windows firewall — all must hold together (§5).
10. **Protocol churn.** Emit legacy behind a `toHappyRecord()` mapper; keep a v2 mapper stub; pin behavior with tests against the real app.

---

## 8. Explicitly NOT doing
Not forking/rebuilding/publishing the app. Not touching `api.cluster-fluster.com` or anyone's real Happy account (our relay is standalone, single-user). Not implementing dataKey/v2 crypto, artifacts, KV, social/feed, or voice for the MVP.

## 9. Temp clone
`slopus/happy` @ `d2ef88d` is cloned at `C:\Users\anikundu\AppData\Local\Temp\happy-study` (disposable). **Keep it** — an S1a validation spike reuses it to run the standalone relay. Remove when the spike is done.
