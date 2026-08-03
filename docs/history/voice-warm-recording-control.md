# Voice warm must not disable stop-recording — 2026-08-02

The real browser audio pipeline found that recording starts while the model host
is idle, then `voice_warm` transitions it to loading. The normal availability
handler reacted by disabling the microphone button even though that same button
is the stop control. Toggle recording then remained active indefinitely.

The client now caches the loading status but defers applying availability while
`_voiceRecordingActive` is true. The live stop control remains enabled, recorded
audio is submitted, and the server's bounded cold-demand path completes
transcription.
