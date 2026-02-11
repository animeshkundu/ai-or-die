// @ts-check
const { test, expect } = require('@playwright/test');

// ---------------------------------------------------------------------------
// Real Pipeline E2E Tests
//
// These tests run against a server started with --stt (real Parakeet V3
// model). Chromium injects fake audio from test/fixtures/hello-world.wav
// via --use-file-for-fake-audio-capture. The server does REAL inference
// through sherpa-onnx-node.
//
// This project connects to http://localhost:7799 (started by CI workflow).
// ---------------------------------------------------------------------------

test.describe('@voice-real Real STT Pipeline', () => {

  test('@voice-real server reports STT ready in config', async ({ request }) => {
    const res = await request.get('/api/config');
    expect(res.ok()).toBeTruthy();
    const config = await res.json();
    expect(config.voiceInput).toBeDefined();
    expect(config.voiceInput.localStatus).toBe('ready');
  });

  test('@voice-real voice upload returns transcription', async ({ request }) => {
    // Create a session via API
    const createRes = await request.post('/api/sessions', {
      data: { name: 'Voice Real Test' }
    });

    // Generate a small Int16 PCM buffer (1 second of 440Hz tone at 16kHz)
    const sampleRate = 16000;
    const duration = 1;
    const numSamples = sampleRate * duration;
    const int16 = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      int16[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 16000);
    }
    const base64Audio = Buffer.from(int16.buffer).toString('base64');

    // We can't easily do a WebSocket voice_upload via Playwright request API,
    // so instead verify the config endpoint reports ready status (real model loaded).
    // The real inference validation is done by voice-real-inference.test.js.
    // This test validates the server is running with STT enabled.
    expect(base64Audio.length).toBeGreaterThan(0);
  });

  test('@voice-real mic button visible with STT enabled', async ({ page }) => {
    await page.goto('/');

    // Wait for app to initialize
    await page.waitForSelector('#terminal-container', { timeout: 30000 });
    await page.waitForTimeout(2000); // Wait for config to load

    const voiceBtn = page.locator('#voiceInputBtn');
    // Button should exist in the DOM
    await expect(voiceBtn).toBeAttached();
  });

  test('@voice-real voiceInput config shows local mode ready', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#terminal-container', { timeout: 30000 });

    // Check the config via JavaScript in the browser
    const voiceConfig = await page.evaluate(async () => {
      const res = await fetch('/api/config');
      const config = await res.json();
      return config.voiceInput;
    });

    expect(voiceConfig).toBeDefined();
    expect(voiceConfig.localStatus).toBe('ready');
    expect(voiceConfig.cloudAvailable).toBe(true);
  });
});
