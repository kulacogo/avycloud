'use strict';

const { GPSR_FIELDS } = require('../lib/chat-datasheet-contract');
const { buildCaptureRequirements, GPSR_CONTENT_SCHEMA, sanitizeCaptureGpsr } = require('../lib/capture-content-contract');
const { normalizeHighlightsStrict } = require('../lib/highlights-policy');

it('derives generation instructions from the actual category-specific highlight policy', () => {
  for (const category of ['Baby > Bettausstattung', 'Computer > Notebooks', 'Auto > Ersatzteile']) {
    const rules = normalizeHighlightsStrict({ identification: { category } }, []).rules;
    const prompt = buildCaptureRequirements({ category: { ebayBreadcrumb: category } });
    expect(prompt).toContain(`${Math.max(5, rules.min)}-${Math.max(5, rules.max)}`);
    expect(prompt).toContain(`${rules.minLen}-${rules.maxLen}`);
  }
});

it('gives both content generators every GPSR field from the canonical contract', () => {
  const { CONTENT_SCHEMA } = require('../lib/gemini3-client');
  const agentic = require('../lib/identify-v3-stage3-agentic')._internal;
  expect(Object.keys(GPSR_CONTENT_SCHEMA.properties)).toEqual([...GPSR_FIELDS]);
  expect(CONTENT_SCHEMA.properties.gpsr).toEqual(GPSR_CONTENT_SCHEMA);
  expect(agentic.WRITE_DATASHEET_DECLARATION.parameters.properties.gpsr).toEqual(GPSR_CONTENT_SCHEMA);
  const gpsr = { manufacturer_city: 'Shenzhen', eu_responsible_name: 'EU GmbH', eu_responsible_email: 'eu@example.com', unknown: 'drop' };
  expect(agentic.sanitizeWriteArgs({ gpsr }).gpsr).toEqual(sanitizeCaptureGpsr(gpsr));
  expect(sanitizeCaptureGpsr(gpsr)).not.toHaveProperty('unknown');
});

it('passes known representative data to generation and prohibits inventing it', () => {
  const prompt = buildCaptureRequirements({ gpsr: { found: true, data: { eu_responsible_name: 'EU GmbH' } } });
  expect(prompt).toContain('EU GmbH');
  expect(prompt).toContain('Nicht erfinden');
});
