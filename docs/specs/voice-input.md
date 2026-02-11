# Voice Input Specification

## Overview

Voice input allows users to speak instead of type. Two modes are supported:

1. **Cloud mode** (Chrome/Edge): Uses the browser's built-in `SpeechRecognition` API. Instant, zero download. Audio is sent to Google servers (privacy tradeoff disclosed on first use).
2. **Local mode** (`--stt` flag): Embedded Parakeet V3 INT8 via `sherpa-onnx-node`. Fully private, works offline. Requires a one-time ~670MB model download.

Cloud mode is always available on Chromium browsers regardless of the `--stt` flag. Local mode requires the flag and a downloaded model.

---

## Architecture

```
Browser (Chrome/Edge primary)              Node.js Server
+------------------------+                 +------------------------------+
| Cloud mode:            |                 |                              |
|   SpeechRecognition API|---(Google)--->  |                              |
|   Zero download        |    text         |                              |
|                        |                 |                              |
| Local mode:            |    binary WS    |  Main thread                 |
|   Web Audio API        |---------------> |    |                         |
|   16kHz PCM            |                 |  voice_upload handler        |
|   (Chromium: native    |<--------------- |    |                    Worker|
|    Others: resample)   |  transcription  |  stt-engine.js ---> stt-worker|
+------------------------+                 |                    sherpa-onnx|
                                           |                    Parakeet V3|
                                           |  ~/.ai-or-die/models/ (670MB)|
                                           +------------------------------+
```

---

## Client Side

### Recording — Two Backends

**Cloud mode (`SpeechRecognitionRecorder`):** Uses `webkitSpeechRecognition` with `continuous: true` and `interimResults: false`. Returns text directly — no audio is sent to the server. A privacy notice is shown on first use.

**Local mode (`LocalVoiceRecorder`):** Records audio via Web Audio API and sends raw PCM to the server.

- **Chromium fast path**: `AudioContext({ sampleRate: 16000 })` — native 16kHz capture, no client-side resampling needed. Covers ~85% of users.
- **Firefox/Safari fallback**: Native sample rate capture with client-side linear interpolation resampling to 16kHz before sending.
- **Primary recorder**: AudioWorklet (`voice-processor.js`) — runs off the main thread, avoids competing with xterm.js rendering.
- **Fallback**: ScriptProcessorNode for older browsers that lack AudioWorklet support.
- On stop: resample if needed, convert Float32 to Int16, send as binary WebSocket frame.

### Interaction Modes

Both click-to-toggle and push-to-talk are supported:

| Mode | Trigger | Best For |
|------|---------|----------|
| Click-to-toggle | Click mic button or single press Ctrl+Shift+M | Long dictation (30-120s) |
| Push-to-talk | Hold Ctrl+Shift+M | Short commands (5-15s) |

**Detection**: If `keydown` is followed by `keyup` within 300ms, it is a toggle. If held longer, it is push-to-talk.

**Both modes end the same way**: text is injected directly into the terminal input. No preview modal, no auto-Enter. The user reviews, edits if needed, and presses Enter when satisfied.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+Shift+M | Toggle recording or push-to-talk (hold) |
| Escape | Cancel and discard recording |

---

## Server Side

### STT Engine (`src/stt-engine.js`)

Coordinates the model manager and worker thread:

- **Concurrency queue**: Maximum 3 simultaneous transcriptions. Requests beyond the limit are rejected with "queue full".
- **Worker thread** (`src/stt-worker.js`): Loads model via `sherpa-onnx-node`, runs inference. Crash recovery with exponential backoff (1s, 2s, 4s, max 15s).
- **External endpoint**: Optional override via `--stt-endpoint` for OpenAI-compatible POST endpoints.
- **Model preloading**: If the model is already cached, it is loaded at server startup in parallel with other initialization to eliminate the 5-15s first-click delay.

### Model Management (`src/utils/model-manager.js`)

Downloads, caches, and validates the Parakeet V3 INT8 ONNX model:

- **Source**: Individual files from HuggingFace (`encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt`).
- **Integrity**: Hardcoded SHA-256 hashes verified after download and on load.
- **Resume**: Incomplete downloads resume via HTTP Range headers. Files download to `.incomplete` and rename on completion.
- **Storage**: `~/.ai-or-die/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/`

---

## WebSocket Protocol

### Messages

| Message | Direction | Payload | Description |
|---------|-----------|---------|-------------|
| `voice_upload` | Client -> Server | base64-encoded Int16 PCM (16kHz mono) | Audio data for transcription |
| `voice_transcription` | Server -> Client | `{ text }` | Transcription result |
| `voice_transcription_error` | Server -> Client | `{ error }` | Transcription failure |
| `voice_model_progress` | Server -> Client | `{ progress, total, eta }` | Model download progress |
| `voice_download_model` | Client -> Server | `{}` | Request to start model download |
| `voice_status` | Server -> Client | `{ localStatus, cloudAvailable }` | STT engine availability |

### Binary Frame Protocol

Local mode audio uses binary WebSocket frames with a `0x01` prefix byte followed by raw Int16 PCM data.

### Validation

- **Buffer size limit**: Maximum 3,840,000 bytes (120s at 16kHz, 2 bytes per sample).
- **Rate limiting**: 10 voice uploads per minute per session.
- **Timeout**: 60 seconds per transcription request.

---

## UX States

| State | Visual |
|-------|--------|
| Idle | Gray mic icon, standard hover |
| Recording | Red filled mic icon + subtle pulse animation + elapsed timer (`0:12`) |
| Processing | 14px CSS spinner replacing icon, tooltip "Transcribing..." |
| Downloading | Download arrow overlay, tooltip "Voice Input (requires one-time setup)" |
| Error | Toast notification (existing `.clipboard-toast` pattern), button returns to idle |
| Disabled | `opacity: 0.35`, `cursor: not-allowed`, tooltip "Voice input not available" |

### Model Download First-Run

Non-blocking banner at top of terminal (`.app-tunnel-banner` pattern):
- Progress bar + percentage + ETA
- Dismiss button — app fully usable during download
- Completion: banner fades, toast "Voice input is ready."
- Failure: "Model download failed. [Retry]"

---

## Security

- **Cloud mode privacy**: Disclosure on first use that audio is sent to Google.
- **Rate limiting**: 10 voice uploads per minute per session (sliding window, in-memory).
- **Buffer size**: Server rejects payloads exceeding 3,840,000 bytes.
- **No auto-Enter**: Transcription text is injected without submitting, preventing accidental command execution.

---

## Configuration

### CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--stt` | Enable local speech-to-text | disabled |
| `--stt-endpoint <url>` | External STT endpoint (OpenAI-compatible) | |
| `--stt-model-dir <path>` | Custom model directory | `~/.ai-or-die/models/` |
| `--stt-threads <number>` | CPU threads for STT inference | auto (max 4) |

### Environment Variables

`STT_ENABLED`, `STT_ENDPOINT`, `AI_OR_DIE_MODELS_DIR`, `STT_THREADS`

---

## Browser Support

| Browser | Cloud Mode | Local Mode | Notes |
|---------|-----------|------------|-------|
| Chrome / Edge | Full (SpeechRecognition) | Full (16kHz fast path) | Primary target |
| Firefox | Not available | Supported (resampling) | No SpeechRecognition API |
| Safari | Not available | Supported (resampling) | No SpeechRecognition API |

---

## Limitations

- **Model size**: ~670MB one-time download for local mode.
- **RAM usage**: ~1.2GB (10s audio) to ~4GB (120s audio) during inference.
- **CPU-only inference**: No GPU acceleration. 4 threads by default.
- **Maximum recording**: 120 seconds (auto-stop).
- **Minimum recording**: <0.5s recordings are silently discarded.
- **Language**: English only (Parakeet V3 is English-only).

---

## Testing

Three-tier CI strategy (all on GitHub Actions, no local testing):

1. **Unit tests** (`test/voice-input.test.js`): ModelManager SHA-256 verification, SttEngine queue/crash recovery, PTT timing logic, message validation, rate limiting.
2. **Integration tests** (`test/voice-integration.test.js`): Real `sherpa-onnx-node` inference against test WAVs, WebSocket protocol, concurrency, error paths, worker recovery.
3. **E2E browser tests** (`test/e2e/voice.spec.js`): Playwright with Chromium fake audio — real audio through the full pipeline (AudioContext -> WebSocket -> sherpa-onnx -> transcription -> terminal injection).

The 670MB Parakeet V3 model is cached across CI runs via `actions/cache`.

---

## Files

| File | Role |
|------|------|
| `src/utils/model-manager.js` | Download, cache, validate Parakeet V3 model |
| `src/stt-worker.js` | Worker thread: load model, run inference |
| `src/stt-engine.js` | Model + worker coordinator, concurrency queue |
| `src/public/voice-handler.js` | Browser recording (cloud + local modes) |
| `src/public/voice-processor.js` | AudioWorklet processor |
| `src/public/components/voice-input.css` | All voice UI states and animations |
| `src/server.js` | WebSocket handlers, binary frames, STT init |
| `src/public/app.js` | Voice UI, mode selection, keyboard shortcuts |
| `bin/ai-or-die.js` | CLI flags (--stt, --stt-endpoint, etc.) |
