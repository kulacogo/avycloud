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

it('laesst im Abnahmepfad keinen beibehaltenen Originalhintergrund durch', () => {
  expect(classifyIdentityVerdict({ ...clean(), backgroundClean: false }, { requireApproval: true }).action).toBe('verwerfen');
});
it('laesst weder fehlende noch unsichere Farbpruefung in die Galerie', () => {
  for (const verdict of [null, { ...clean(), backgroundClean: true, confidence: 0.2 }, { ...clean(), backgroundClean: true, colorKept: undefined }]) {
    expect(classifyIdentityVerdict(verdict, { requireApproval: true }).action).toBe('verwerfen');
  }
});
it('trennt zulässige Anwendungsszenen von Studiohintergrund und Farbtreue', () => {
  expect(classifyIdentityVerdict({ ...clean(), backgroundClean: false }, { requireApproval: true, requireCleanBackground: false }).action).toBe('ok');
  expect(classifyIdentityVerdict({ ...clean(), colorKept: false }, { requireApproval: true, requireCleanBackground: false }).action).toBe('verwerfen');
});


describe('deterministischer Schutz dunkler Produktfarbe', () => {
  const sharp = require('sharp');
  const { validateDarkMaterialColor } = require('../lib/image-result-check');
  const photo = async (color) => sharp({ create: { width: 640, height: 640, channels: 3, background: '#eee' } })
    .composite([{ input: await sharp({ create: { width: 400, height: 400, channels: 3, background: color } }).png().toBuffer(), left: 120, top: 120 }])
    .png().toBuffer();
  it.each(['#555555', '#314761'])('stoppt Schwarz zu Grau/Blau (%s) ohne Modellurteil', async color => {
    const result = await validateDarkMaterialColor([await photo('#202428')], await photo(color));
    expect(result.ok).toBe(false);
    expect(result.checked).toBe(true);
  });
  it('erlaubt moderate Lichtkorrektur bei weiterhin dunklem Material', async () => {
    expect((await validateDarkMaterialColor([await photo('#202428')], await photo('#282c30'))).ok).toBe(true);
  });
  it('behauptet bei hellen Artikeln keine Farbpruefung durch diesen Spezialschutz', async () => {
    expect(await validateDarkMaterialColor([await photo('#bbbbbb')], await photo('#cccccc'))).toEqual({ ok: true, checked: false });
  });
  it('laesst eine belegte hellere Seite als Vergleich zu', async () => {
    expect((await validateDarkMaterialColor([await photo('#202428'), await photo('#555555')], await photo('#555555'))).ok).toBe(true);
  });
  it('meldet nicht lesbare Bilddaten statt sie zu bestaetigen', async () => {
    expect((await validateDarkMaterialColor([Buffer.from('invalid')], await photo('#202428'))).ok).toBe(false);
  });
});
