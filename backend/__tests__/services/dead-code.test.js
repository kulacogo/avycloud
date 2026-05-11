'use strict';

// Vitest globals (globals: true in vitest.config.js)
//
// Anti-Regression-Test for Phase B.2 of plan
//   /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md
//
// Ensures `services/enrichment_backup.js` stays dead code: no production
// path under routes/, services/, or lib/ may require it. Self-references
// inside the file itself are ignored.

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = ['routes', 'services', 'lib'];
const TARGET = 'enrichment_backup';

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      out.push(...walk(full));
    } else if (ent.isFile() && /\.(js|cjs|mjs)$/.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

function findReferences(target) {
  const hits = [];
  for (const sub of SCAN_DIRS) {
    const dir = path.join(BACKEND_ROOT, sub);
    const files = walk(dir);
    for (const file of files) {
      // Skip the file itself (self-reference is allowed)
      if (path.basename(file) === `${target}.js`) continue;

      let contents;
      try {
        contents = fs.readFileSync(file, 'utf8');
      } catch (_err) {
        continue;
      }

      const lines = contents.split('\n');
      lines.forEach((line, idx) => {
        // Match require('.../enrichment_backup') or require('.../enrichment_backup.js')
        const re = new RegExp(`require\\([^)]*${target}(?:\\.js)?['"]\\)`);
        if (re.test(line)) {
          hits.push({ file: path.relative(BACKEND_ROOT, file), line: idx + 1, text: line.trim() });
        }
      });
    }
  }
  return hits;
}

describe('dead-code: enrichment_backup.js', () => {
  it('has zero require references in routes/, services/, lib/ (outside itself)', () => {
    const hits = findReferences(TARGET);
    if (hits.length > 0) {
      const pretty = hits.map(h => `  ${h.file}:${h.line}  ${h.text}`).join('\n');
      throw new Error(
        `enrichment_backup.js is dead code, but ${hits.length} require reference(s) were found:\n${pretty}\n\n` +
        'If this is intentional, update the deprecation header in backend/services/enrichment_backup.js ' +
        'and the plan at /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase B.2).'
      );
    }
    expect(hits).toEqual([]);
  });
});
