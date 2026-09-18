'use strict';
const { classifyIdentityVerdict } = require('../lib/image-result-check');
const clean = () => ({ sameItem: true, perspectiveKept: true, markingsKept: true,
  conditionKept: true, materialKept: true, colorKept: true, evidenceKept: true,
  confidence: 0.95, problems: [] });

it('akzeptiert professionelle Lichtkorrektur bei unverändertem Artikel', () => {
  expect(classifyIdentityVerdict(clean()).action).toBe('ok');
});
it.each(['conditionKept', 'materialKept', 'colorKept', 'evidenceKept', 'markingsKept'])(
  'verwirft eine sicher erkannte Veränderung von %s auch bei derselben Produktidentität', (field) => {
    expect(classifyIdentityVerdict({ ...clean(), [field]: false }).action).toBe('verwerfen');
  },
);
it('behauptet bei fehlender Zustandsprüfung keinen geprüften Erfolg', () => {
  const result = clean();
  delete result.conditionKept;
  expect(classifyIdentityVerdict(result).action).toBe('warnen');
});
it('macht aus einem unsicheren Urteil keine sichere Verwerfung', () => {
  expect(classifyIdentityVerdict({ ...clean(), conditionKept: false, confidence: 0.2 }).action).toBe('warnen');
});

it('übernimmt die differenzierte Qualitätsprüfung aus dem strukturierten Modellurteil', async () => {
  const { judgeProductIdentity } = require('../lib/image-result-check');
  const aiClient = { models: { generateContent: vi.fn(async () => ({ text: JSON.stringify({
    same_item: true, perspective_kept: true, markings_kept: true, condition_kept: false,
    material_kept: true, color_kept: true, evidence_kept: true, confidence: 0.95, problems: ['Kratzer entfernt'],
  }) })) } };
  const verdict = await judgeProductIdentity([{ inlineData: { data: 'reference', mimeType: 'image/png' } }],
    { data: 'candidate', mimeType: 'image/png' }, { aiClient });
  expect(verdict.conditionKept).toBe(false);
  expect(classifyIdentityVerdict(verdict).action).toBe('verwerfen');
});
