'use strict';
const sharp = require('sharp');
const { classifyIdentityVerdict } = require('../lib/image-result-check');
const { summarizeEvidence, planGalleryVariants } = require('../lib/image-viewpoint');
const good = { sameItem: true, perspectiveKept: true, markingsKept: true, conditionKept: true,
  materialKept: true, colorKept: true, evidenceKept: true, backgroundClean: true,
  studioLighting: true, grounded: true, compositionGood: true, confidence: 0.95, problems: [] };
it.each(['studioLighting', 'grounded', 'compositionGood'])('rejects flat/floating/poorly framed studio output: %s', field => {
  for (const value of [false, undefined]) {
    expect(classifyIdentityVerdict({ ...good, [field]: value }, { requireApproval: true, requireStudioPresentation: true }).action).toBe('verwerfen');
  }
  expect(classifyIdentityVerdict(good, { requireApproval: true, requireStudioPresentation: true }).action).toBe('ok');
});
it('keeps identity rejection even with excellent presentation', () => {
  expect(classifyIdentityVerdict({ ...good, colorKept: false }, { requireApproval: true, requireStudioPresentation: true }).action).toBe('verwerfen');
});
it('never uses a detached lid or inner bin as the full-product hero', () => {
  const view = (index, viewpoint, subjectRole) => ({ index, viewpoint, subjectRole, showsProduct: true,
    fullyVisible: true, usableAsReference: true, confidence: 0.98, verpackungsreste: 'keine' });
  const evidence = summarizeEvidence({ views: [view(0, 'front', 'complete'), view(1, 'top', 'component'), view(2, 'front', 'component'), view(3, 'top', 'detail')] });
  expect(evidence.vorlageIndexes).toEqual([0]);
  expect(evidence.byViewpoint.top).toBeUndefined();
  const { plan } = planGalleryVariants(evidence, { lifestyle: false });
  expect(plan.find(p => p.key === 'hero')?.sourceIndex).toBe(0);
  expect(plan.filter(p => p.sourceIndex !== 0).every(p => p.key === 'detail')).toBe(true);
});
it('preserves the photographed shadow and edges when finishing the canvas', async () => {
  const { finishStudioCanvas } = require('../lib/studio-photography');
  const source = await sharp({ create: { width: 1600, height: 1800, channels: 3, background: '#ffffff' } })
    .composite([{ input: Buffer.from('<svg width="1600" height="1800"><rect x="200" y="200" width="1200" height="1200" fill="#222"/><ellipse cx="800" cy="1450" rx="600" ry="40" fill="#aaa"/></svg>') }]).png().toBuffer();
  const result = await finishStudioCanvas(source);
  expect([result.width, result.height]).toEqual([1800, 1800]);
  const restored = await sharp(result.buffer).extract({ left: 100, top: 0, width: 1600, height: 1800 }).raw().toBuffer();
  expect(restored.equals(await sharp(source).raw().toBuffer())).toBe(true);
});
it('requests and parses presentation in the same identity call, without relaxing identity', async () => {
  const { judgeProductIdentity } = require('../lib/image-result-check');
  const fields = { same_item: true, perspective_kept: true, markings_kept: true, condition_kept: true,
    material_kept: true, color_kept: true, evidence_kept: true, background_clean: true, confidence: 0.95,
    studio_lighting: false, grounded: true, composition_good: true, problems: [] };
  const aiClient = { models: { generateContent: vi.fn(async () => ({ text: JSON.stringify(fields) })) } };
  const result = await judgeProductIdentity([{ inlineData: { data: 'reference', mimeType: 'image/png' } }],
    { data: 'candidate', mimeType: 'image/png' }, { aiClient, requireStudioPresentation: true });
  expect(result.studioLighting).toBe(false);
  expect(result.grounded).toBe(true);
  expect(classifyIdentityVerdict(result, { requireApproval: true, requireStudioPresentation: true }).action).toBe('verwerfen');
  expect(aiClient.models.generateContent).toHaveBeenCalledTimes(1);
  const call = aiClient.models.generateContent.mock.calls[0][0];
  expect(call.config.responseJsonSchema.required).toEqual(expect.arrayContaining(['color_kept', 'studio_lighting', 'grounded', 'composition_good']));
});
