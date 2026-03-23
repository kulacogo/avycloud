/**
 * Tests for callGeminiWithRetry — exponential backoff retry wrapper.
 */
const { callGeminiWithRetry } = require('../lib/gemini-retry');

describe('callGeminiWithRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true });
    const result = await callGeminiWithRetry(fn);
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 rate limit error', async () => {
    const err429 = new Error('rate limited');
    err429.status = 429;
    const fn = vi.fn()
      .mockRejectedValueOnce(err429)
      .mockResolvedValue({ ok: true });

    const result = await callGeminiWithRetry(fn, { maxRetries: 2, delayMs: 10 });
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 503 service unavailable', async () => {
    const err503 = new Error('unavailable');
    err503.status = 503;
    const fn = vi.fn()
      .mockRejectedValueOnce(err503)
      .mockResolvedValue({ ok: true });

    const result = await callGeminiWithRetry(fn, { maxRetries: 1, delayMs: 10 });
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on timeout error', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('request timeout'))
      .mockResolvedValue({ ok: true });

    const result = await callGeminiWithRetry(fn, { maxRetries: 1, delayMs: 10 });
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on RESOURCE_EXHAUSTED', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('RESOURCE_EXHAUSTED'))
      .mockResolvedValue({ ok: true });

    const result = await callGeminiWithRetry(fn, { maxRetries: 1, delayMs: 10 });
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 400 bad request', async () => {
    const err400 = new Error('bad request');
    err400.status = 400;
    const fn = vi.fn().mockRejectedValue(err400);

    await expect(callGeminiWithRetry(fn, { maxRetries: 2, delayMs: 10 }))
      .rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting retries', async () => {
    const err429 = new Error('rate limited');
    err429.status = 429;
    const fn = vi.fn().mockRejectedValue(err429);

    await expect(callGeminiWithRetry(fn, { maxRetries: 2, delayMs: 10 }))
      .rejects.toThrow('rate limited');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
