import { describe, it, expect } from 'vitest';

// We cannot integration-test the real SDK without @github/copilot CLI installed
// and a Copilot subscription. These are unit tests for the exported helpers and
// basic class behavior.

describe('CopilotSdkBackend', () => {
  it('has correct provider info', async () => {
    const { CopilotSdkBackend } = await import('./copilot-sdk-backend.js');
    const backend = new CopilotSdkBackend();
    expect(backend.info.name).toBe('copilot');
    expect(backend.info.supportsStreaming).toBe(true);
    expect(backend.info.supportsTools).toBe(true);
  });

  it('throws PROVIDER_UNAVAILABLE when client not initialized for listModels', async () => {
    const { CopilotSdkBackend } = await import('./copilot-sdk-backend.js');
    const backend = new CopilotSdkBackend();
    await expect(backend.listModels()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('throws PROVIDER_UNAVAILABLE when client not initialized for streamCompletion', async () => {
    const { CopilotSdkBackend } = await import('./copilot-sdk-backend.js');
    const backend = new CopilotSdkBackend();
    const iter = backend.streamCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    await expect(async () => {
      for await (const _chunk of iter) { /* consume */ }
    }).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('throws PROVIDER_UNAVAILABLE when client not initialized for chatWithTools', async () => {
    const { CopilotSdkBackend } = await import('./copilot-sdk-backend.js');
    const backend = new CopilotSdkBackend();
    await expect(
      backend.chatWithTools(
        [{ role: 'user', content: 'test' }],
        [{ name: 't', description: 't', parameters: { type: 'object', properties: {}, required: [] } }]
      )
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('dispose is safe to call when client is null', async () => {
    const { CopilotSdkBackend } = await import('./copilot-sdk-backend.js');
    const backend = new CopilotSdkBackend();
    expect(() => backend.dispose()).not.toThrow();
  });
});

describe('isCopilotCliAvailable', () => {
  it('is exported as a function', async () => {
    const { isCopilotCliAvailable } = await import('./copilot-sdk-backend.js');
    expect(typeof isCopilotCliAvailable).toBe('function');
  });
});
