// @ts-check
const { test, expect } = require('@playwright/test');

// ---------------------------------------------------------------------------
// Real Pipeline E2E Tests
//
// These tests run against a server started with --stt (real Parakeet V3
// model loaded via sherpa-onnx-node). They validate the server-side STT
// pipeline is functional via API calls.
//
// Browser-level UI tests (mic button, recording states, keyboard shortcuts)
// are covered by the voice-e2e project. This project focuses on verifying
// the real inference backend is wired up correctly.
//
// Connects to http://localhost:7799 (started by CI workflow).
// ---------------------------------------------------------------------------

test.describe('@voice-real Real STT Pipeline', () => {

  test('@voice-real server reports STT ready in config', async ({ request }) => {
    const res = await request.get('/api/config');
    expect(res.ok()).toBeTruthy();
    const config = await res.json();
    expect(config.voiceInput).toBeDefined();
    expect(config.voiceInput.localStatus).toBe('ready');
    expect(config.voiceInput.cloudAvailable).toBe(true);
  });

  test('@voice-real config returns valid voice input shape', async ({ request }) => {
    const res = await request.get('/api/config');
    const config = await res.json();

    // Verify the voiceInput config has the expected structure
    expect(typeof config.voiceInput.localStatus).toBe('string');
    expect(typeof config.voiceInput.cloudAvailable).toBe('boolean');
    expect(['ready', 'loading', 'downloading', 'unavailable', 'busy'])
      .toContain(config.voiceInput.localStatus);
  });
});
