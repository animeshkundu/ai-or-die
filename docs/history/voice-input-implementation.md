# Voice Input Implementation Notes

## Summary

Added voice-to-text input with two modes: cloud (browser SpeechRecognition API, Chrome/Edge only) and local (embedded Parakeet V3 INT8 via sherpa-onnx-node, private, offline). Users speak instead of type — transcription is injected into the terminal without auto-Enter.

---

## Key Decisions

### ONNX over GGUF for Parakeet V3

GGUF does not exist for Parakeet V3. Research confirmed zero GGUF models on HuggingFace for Parakeet — the only attempt (`parakeet.cpp`) is abandoned and `whisper.cpp` does not support the Parakeet architecture. Handy (the reference implementation that validated this pipeline) also uses ONNX.

### Embedded STT over external service

Running sherpa-onnx-node in-process (worker thread) avoids requiring users to set up a separate STT service. The ~670MB model download is a one-time cost cached in `~/.ai-or-die/models/`. An `--stt-endpoint` flag provides an escape hatch for users who prefer an external OpenAI-compatible endpoint.

### Web Audio API over MediaRecorder

MediaRecorder outputs compressed audio (Opus/WebM) which would require server-side decoding before inference. Web Audio API provides raw PCM samples directly, matching what sherpa-onnx expects (16kHz Int16 PCM). This eliminates a decoding step and avoids codec compatibility issues across browsers.

### AudioWorklet over ScriptProcessorNode

ScriptProcessorNode runs on the main thread and is deprecated. AudioWorklet runs in a separate thread, avoiding competition with xterm.js rendering for main thread time. ScriptProcessorNode is kept as a fallback for older browsers.

### Parakeet V3 INT8 model selection

Parakeet V3 INT8 is the ideal balance for CPU inference: small enough for reasonable download (~670MB) and RAM (~1.2-4GB depending on audio length), fast enough for interactive use (2-3s for 10s audio on 4 threads), and accurate enough for coding dictation.

---

## Research Findings

- **Handy** (github.com/cjpais/Handy) validated the record-to-Parakeet-V3 pipeline but is a Tauri desktop app — its audio pipeline is not extractable for web use.
- **sherpa-onnx-node** provides prebuilt native binaries for Windows/Linux, avoiding the need to compile ONNX Runtime from source. Version >= 1.12.24 required (includes fix for missing words bug, sherpa-onnx issue #2605).
- **Chromium AudioContext 16kHz**: Chrome and Edge support creating an AudioContext at 16kHz sample rate directly, eliminating client-side resampling for ~85% of users. Firefox and Safari ignore the requested sample rate and use the system default, requiring client-side resampling.
- **HuggingFace model hosting**: Individual ONNX files can be fetched directly via `/resolve/main/` URLs, supporting HTTP Range headers for download resume.

---

## Challenges

### Firefox/Safari AudioContext resampling

Firefox throws when attempting `new AudioContext({ sampleRate: 16000 })` if the system sample rate differs. Safari silently ignores the requested rate. The solution is a try/catch with fallback: attempt 16kHz first, fall back to default rate with client-side linear interpolation resampling.

### SEA binary compatibility

sherpa-onnx-node uses platform-specific native addons (same pattern as @lydell/node-pty). The SEA build extracts native files at runtime via a shim that mirrors the existing approach in `scripts/build-sea.js`.

### sherpa-onnx missing words bug

sherpa-onnx versions before 1.12.24 occasionally dropped words from Parakeet V3 transcriptions (issue #2605). The fix is to pin `sherpa-onnx-node >= 1.12.24` in package.json.

---

## References

- Handy: https://github.com/cjpais/Handy
- sherpa-onnx missing words issue: https://github.com/k2-fsa/sherpa-onnx/issues/2605
- Parakeet V3 INT8 model: https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
