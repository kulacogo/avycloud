'use strict';

// Vitest CJS; globals enabled (describe/it/expect).
//
// Tests fuer die 8 Identify-Side Scope-JSON-Prompt-Definitions in
// backend/lib/llm-prompts/scopes/. Validiert Schema-Konformitaet,
// Pflichtfelder, Leitfaden-Audit-Trail und Konsistenz mit cassini-category-map.
// Schema ist kompatibel mit backend/scripts/seed-llm-scopes.js
// (scopeId/name/purpose/version-block).

const fs = require('fs');
const path = require('path');

const SCOPES_DIR = path.join(__dirname, '..', '..', 'lib', 'llm-prompts', 'scopes');

const IDENTIFY_SCOPES = [
  'identify-identity',
  'identify-category',
  'identify-attributes',
  'identify-seo-title',
  'identify-seo-description',
  'identify-pricing',
  'identify-image',
  'identify-gpsr',
];

// Top-level required fields per scope-file (seed-llm-scopes.js schema).
const TOP_LEVEL_REQUIRED = ['scopeId', 'name', 'purpose', 'version', 'tenantOverrides'];

// Required fields inside the nested version object.
const VERSION_REQUIRED = [
  'promptText',
  'rulesText',
  'promptMode',
  'rulesMode',
  'userTemplate',
  'outputSchemaHint',
  'generationConfig',
  'leitfadenSections',
];

const VALID_MODES = new Set(['append', 'replace']);

function loadScope(slug) {
  const file = path.join(SCOPES_DIR, `${slug}.json`);
  const raw = fs.readFileSync(file, 'utf-8');
  return JSON.parse(raw);
}

describe('llm-prompts/scopes — Identify scope JSON definitions', () => {
  describe('directory + file existence', () => {
    it('scopes directory exists', () => {
      expect(fs.existsSync(SCOPES_DIR)).toBe(true);
    });

    it('all 8 identify scope JSON files exist', () => {
      for (const slug of IDENTIFY_SCOPES) {
        const file = path.join(SCOPES_DIR, `${slug}.json`);
        expect(fs.existsSync(file), `missing: ${slug}.json`).toBe(true);
      }
    });
  });

  describe.each(IDENTIFY_SCOPES)('scope %s', (slug) => {
    const scope = loadScope(slug);

    it('has all top-level required fields (seed-llm-scopes compatible)', () => {
      for (const field of TOP_LEVEL_REQUIRED) {
        expect(scope, `${slug}: missing top-level field ${field}`).toHaveProperty(field);
      }
    });

    it('scopeId follows identify.* namespace', () => {
      expect(typeof scope.scopeId).toBe('string');
      expect(scope.scopeId.startsWith('identify.')).toBe(true);
    });

    it('version block has all required fields', () => {
      for (const field of VERSION_REQUIRED) {
        expect(scope.version, `${slug}: missing version.${field}`).toHaveProperty(field);
      }
    });

    it('version.promptText is a substantial non-empty string', () => {
      expect(typeof scope.version.promptText).toBe('string');
      expect(scope.version.promptText.trim().length).toBeGreaterThan(100);
    });

    it('version.rulesText is a non-empty string', () => {
      expect(typeof scope.version.rulesText).toBe('string');
      expect(scope.version.rulesText.trim().length).toBeGreaterThan(50);
    });

    it('version.promptMode + rulesMode are append|replace', () => {
      expect(VALID_MODES.has(scope.version.promptMode)).toBe(true);
      expect(VALID_MODES.has(scope.version.rulesMode)).toBe(true);
    });

    it('version.userTemplate is a non-empty string', () => {
      expect(typeof scope.version.userTemplate).toBe('string');
      expect(scope.version.userTemplate.trim().length).toBeGreaterThan(20);
    });

    it('version.outputSchemaHint is a non-empty string', () => {
      expect(typeof scope.version.outputSchemaHint).toBe('string');
      expect(scope.version.outputSchemaHint.trim().length).toBeGreaterThan(20);
    });

    it('version.generationConfig has temperature + maxOutputTokens within bounds', () => {
      expect(typeof scope.version.generationConfig).toBe('object');
      expect(scope.version.generationConfig).not.toBeNull();
      expect(typeof scope.version.generationConfig.temperature).toBe('number');
      expect(typeof scope.version.generationConfig.maxOutputTokens).toBe('number');
      expect(scope.version.generationConfig.temperature).toBeGreaterThanOrEqual(0);
      expect(scope.version.generationConfig.temperature).toBeLessThanOrEqual(2);
      expect(scope.version.generationConfig.maxOutputTokens).toBeGreaterThan(0);
    });

    it('tenantOverrides is an object (typically empty)', () => {
      expect(typeof scope.tenantOverrides).toBe('object');
      expect(scope.tenantOverrides).not.toBeNull();
    });

    it('version.leitfadenSections is a non-empty array of strings (audit trail)', () => {
      expect(Array.isArray(scope.version.leitfadenSections)).toBe(true);
      expect(scope.version.leitfadenSections.length).toBeGreaterThanOrEqual(1);
      for (const section of scope.version.leitfadenSections) {
        expect(typeof section).toBe('string');
        expect(section.trim().length).toBeGreaterThan(0);
      }
    });

    it('contains no emoji characters (project rule)', () => {
      // Match common emoji ranges. Rough but catches everything users would paste.
      // eslint-disable-next-line no-misleading-character-class
      const emojiPattern = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
      const merged = `${scope.version.promptText} ${scope.version.rulesText} ${scope.version.userTemplate}`;
      expect(emojiPattern.test(merged), `${slug}: emoji detected`).toBe(false);
    });

    it('has a version.note tag identifying F.2.A phase', () => {
      expect(typeof scope.version.note).toBe('string');
      expect(scope.version.note).toContain('F.2.A');
    });
  });

  describe('cross-scope consistency', () => {
    it('all 8 scopes have unique scopeIds', () => {
      const ids = IDENTIFY_SCOPES.map((slug) => loadScope(slug).scopeId);
      const uniq = new Set(ids);
      expect(uniq.size).toBe(IDENTIFY_SCOPES.length);
    });

    it('seo-title scope references the {{category_pattern}} placeholder in userTemplate', () => {
      const scope = loadScope('identify-seo-title');
      expect(scope.version.userTemplate.includes('{{category_pattern}}')).toBe(true);
    });

    it('seo-title scope embeds {{category_pattern}} reference in promptText as well', () => {
      const scope = loadScope('identify-seo-title');
      expect(scope.version.promptText).toContain('{{category_pattern}}');
    });

    it('identity scope mentions GTIN-checksum validation in rules', () => {
      const scope = loadScope('identify-identity');
      expect(scope.version.rulesText.toLowerCase()).toMatch(/(gtin|checksum|pruefziffer)/);
    });

    it('gpsr scope lists placeholder-reject patterns in promptText', () => {
      const scope = loadScope('identify-gpsr');
      const lower = scope.version.promptText.toLowerCase();
      expect(lower).toContain('placeholder');
    });

    it('image scope references white-background + 800-1600px requirement', () => {
      const scope = loadScope('identify-image');
      expect(scope.version.promptText).toMatch(/800/);
      expect(scope.version.promptText).toMatch(/1600/);
      expect(scope.version.promptText.toLowerCase()).toContain('weiss');
    });

    it('seo-description scope references 200-word target + keyword-density 5-7%', () => {
      const scope = loadScope('identify-seo-description');
      expect(scope.version.promptText).toMatch(/200/);
      expect(scope.version.promptText).toMatch(/5-7|5\s*-\s*7/);
    });

    it('attributes scope mentions the 45-aspect cap', () => {
      const scope = loadScope('identify-attributes');
      expect(scope.version.promptText).toContain('45');
    });

    it('pricing scope mentions the -0.30 EUR Cassini sweet-spot tactic', () => {
      const scope = loadScope('identify-pricing');
      const txt = scope.version.promptText.toLowerCase();
      expect(txt).toMatch(/0[.,]30/);
    });

    it('category scope mentions the 0.85 confidence threshold for auto-write', () => {
      const scope = loadScope('identify-category');
      expect(scope.version.promptText).toContain('0.85');
    });
  });

  // F.3 — Compliance-Hardening: ALL 12 scopes must explicitly instruct the
  // LLM to avoid Active Content + Keyword-Spamming + Duplicate-Strings.
  // Quelle Strategischer eBay Leitfaden Sektion 7 (Compliance-Matrix).
  describe('F.3 Compliance-Hardening — Active-Content-Strip + Keyword-Spamming-Verbot', () => {
    const RELEVANT_SCOPES = [
      'identify-identity',
      'identify-category',
      'identify-attributes',
      'identify-seo-title',
      'identify-seo-description',
      'identify-pricing',
      'identify-image',
      'identify-gpsr',
      'identify-critic',
      'chat-context',
      'chat-update-datasheet',
      'quality-gate',
    ];

    describe.each(RELEVANT_SCOPES)('scope %s', (slug) => {
      const scope = loadScope(slug);
      const promptText = scope.version.promptText;
      const combined = `${promptText} ${scope.version.rulesText}`;

      it('contains a Compliance / Cassini-section in the prompt', () => {
        expect(combined).toMatch(/Compliance|Cassini/);
      });

      it('explicitly forbids Active Content (script/iframe/object/embed)', () => {
        expect(promptText).toMatch(/<script>/i);
        expect(promptText).toMatch(/<iframe>/i);
        expect(promptText).toMatch(/<object>/i);
        expect(promptText).toMatch(/<embed>/i);
      });

      it('explicitly forbids javascript:-URL active content', () => {
        expect(promptText.toLowerCase()).toContain('javascript:');
      });

      it('explicitly forbids Keyword-Spamming with token-density / max-occurrence rule', () => {
        const lower = promptText.toLowerCase();
        expect(lower).toMatch(/keyword-spamming|keyword spamming/);
        // Either max-N-occurrence rule or token-density mention.
        const hasOccurrenceRule = /max\s*\d/i.test(promptText);
        const hasDensityRule = /density|dichte/i.test(promptText);
        expect(hasOccurrenceRule || hasDensityRule).toBe(true);
      });

      it('version was bumped to v1.0.1 (or beyond) when Compliance was added', () => {
        // Accept any version >= 1.0.1, look for patch increment in note.
        expect(scope.version.note).toMatch(/v1\.0\.[1-9]|v1\.[1-9]/);
      });

      it('leitfadenSections references Sektion 7 (Compliance)', () => {
        const joined = scope.version.leitfadenSections.join(' ');
        expect(joined).toMatch(/Sektion 7/);
        expect(joined.toLowerCase()).toMatch(/compliance|spamming|active content/);
      });
    });
  });
});
