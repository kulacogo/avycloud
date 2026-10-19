'use strict';
const { withChatRequest, runModelCall, runToolCall, requestUsage, currentRequest } = require('../../lib/chat-request');

describe('UX-36 Anfragebudget', () => {
  it('zählt Versuche und Fallbacks im selben Budget', async () => {
    await withChatRequest({ scope: 'title' }, async () => {
      const expensive = vi.fn().mockResolvedValue('ok');
      await runModelCall(expensive, 'v3');
      await expect(runModelCall(() => Promise.reject(new Error('network')), 'v3-retry')).rejects.toThrow('network');
      await runModelCall(expensive, 'v2-fallback');
      await expect(runModelCall(expensive, 'legacy-fallback')).rejects.toMatchObject({ code: 'CHAT_REQUEST_BUDGET' });
      expect(expensive).toHaveBeenCalledTimes(2);
      expect(requestUsage()).toMatchObject({ modelCalls: 3 });
    }, { maxModelCalls: 3 });
  });
  it('führt nicht erlaubte Werkzeuge nicht aus', async () => {
    await withChatRequest({ scope: 'pricing' }, async () => {
      const image = vi.fn();
      await expect(runToolCall('generate_ai_images', image)).rejects.toMatchObject({ code: 'CHAT_SCOPE_BLOCKED' });
      expect(image).not.toHaveBeenCalled();
    });
  });
  it('isoliert parallele Anfragen und behält das Budget bei verschachteltem Fallback', async () => {
    await Promise.all(['title', 'pricing'].map(scope => withChatRequest({ scope }, async () => {
      await runModelCall(async () => {});
      await withChatRequest({ scope: 'datasheet' }, async () => {
        expect(currentRequest().scope).toBe(scope);
        expect(requestUsage().modelCalls).toBe(1);
      });
    })));
    expect(currentRequest()).toBe(null);
  });
});


it('blocks image search hidden inside a generic SerpAPI tool before execution', async () => {
  const { withChatRequest, runToolCall } = require('../../lib/chat-request');
  const research = vi.fn();
  await withChatRequest({ scope: 'title' }, async () => {
    await expect(runToolCall('serpapi_web_search', research, { engine: 'google_images' })).rejects.toMatchObject({ code: 'CHAT_SCOPE_BLOCKED' });
  });
  expect(research).not.toHaveBeenCalled();
});
