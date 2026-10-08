'use strict';

const evaluate = vi.fn();
const executor = vi.fn(async () => ({ ok: true, data: { material: 'Baumwolle' } }));
for (const [name, exports] of [
  ['../../lib/llm-config', { resolveScopeConfig: async () => null }],
  ['../../lib/grounding-usage', { trackGroundingQueries: () => {} }],
  ['../../lib/capture-content-readiness', { evaluateCaptureContent: evaluate }],
  ['../../services/atomic-tools', { buildToolList: () => [], buildToolExecutorMap: () => ({ lookup: executor }) }],
]) {
  const path = require.resolve(name);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}
const { generateProductContentAgentic } = require('../../lib/identify-v3-stage3-agentic');
const write = title => ({ functionCalls: [{ name: 'write_product_datasheet', args: { title_ebay: title } }] });

describe('capture repairs inside the original research conversation', () => {
  beforeEach(() => { vi.clearAllMocks(); evaluate.mockReturnValue({ ok: true, issues: [] }); });
  afterEach(() => vi.useRealTimers());

  it('returns the corrected second draft and sends concrete gaps back to the model', async () => {
    evaluate.mockReturnValueOnce({ ok: false, issues: ['missing_required_aspect:Material'] });
    const sendMessage = vi.fn().mockResolvedValueOnce(write('Unvollständig')).mockResolvedValueOnce(write('Vollständig'));
    const result = await generateProductContentAgentic({ aiClient: { chats: { create: () => ({ sendMessage }) } } });
    expect(result.title_ebay).toBe('Vollständig');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(sendMessage.mock.calls[1][0].message)).toContain('missing_required_aspect:Material');
    expect(result._agentic.qualityRepairs).toBe(1);
    expect(result._agentic.unresolvedIssues).toEqual([]);
  });

  it('bounds repair cost and preserves the best researched draft with honest unresolved metadata', async () => {
    evaluate.mockReturnValue({ ok: false, issues: ['gpsr_eu_responsible_missing'] });
    const sendMessage = vi.fn().mockResolvedValue(write('Belegter Titel'));
    const result = await generateProductContentAgentic({ aiClient: { chats: { create: () => ({ sendMessage }) } } });
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(result._agentic.unresolvedIssues).toEqual(['gpsr_eu_responsible_missing']);
    expect(result._agentic.qualityRepairs).toBe(2);
  });

  it('aborts an expired request and never continues its tools or conversation later', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(() => new Promise(resolve => setTimeout(() => resolve({ functionCalls: [{ name: 'lookup', args: {} }] }), 2000)));
    const task = generateProductContentAgentic({ deadline: Date.now() + 1000, aiClient: { chats: { create: () => ({ sendMessage }) } } });
    const rejected = expect(task).rejects.toThrow(/timeout|deadline/i);
    await vi.advanceTimersByTimeAsync(1001);
    await rejected;
    await vi.advanceTimersByTimeAsync(2000);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(executor).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0][0].config.abortSignal.aborted).toBe(true);
  });
});
