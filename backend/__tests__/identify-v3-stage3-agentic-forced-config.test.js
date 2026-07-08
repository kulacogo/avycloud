// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// Agentic Stage 3: Forced-Finalize muss die Tool-Deklaration mitschicken.
//
// Produktions-Fehler (Logs 2026-07-08): chat.sendMessage({ config }) ERSETZT
// die Chat-Config im @google/genai SDK, statt sie zu mergen. Der
// Forced-Finalize-Call schickte allowedFunctionNames=[write_product_datasheet]
// OHNE functionDeclarations mit → Gemini 400 "allowed_function_names should be
// a subset of the provided function_declarations" → JEDER agentische
// Stage-3-Lauf fiel auf Single-Shot zurueck (der dann oft timeoutete).

const {
  _internal,
} = require('../lib/identify-v3-stage3-agentic');

describe('Agentic Stage 3 — Forced-Finalize-Config', () => {
  it('exportiert buildForcedFinalizeConfig fuer beide Force-Pfade', () => {
    expect(typeof _internal.buildForcedFinalizeConfig).toBe('function');
  });

  it('deklariert write_product_datasheet in tools UND erlaubt es in allowedFunctionNames', () => {
    const cfg = _internal.buildForcedFinalizeConfig();
    const allowed = cfg.toolConfig.functionCallingConfig.allowedFunctionNames;
    expect(allowed).toEqual(['write_product_datasheet']);

    const declared = (cfg.tools || [])
      .flatMap((t) => t.functionDeclarations || [])
      .map((d) => d.name);
    // Kernregel der Gemini-API: allowedFunctionNames ⊆ declared names
    for (const name of allowed) {
      expect(declared).toContain(name);
    }
  });

  it('nutzt mode ANY (Finalize erzwingen, keine weitere Recherche)', () => {
    const cfg = _internal.buildForcedFinalizeConfig();
    expect(String(cfg.toolConfig.functionCallingConfig.mode)).toMatch(/any/i);
  });

  it('beide sendMessage-Force-Stellen im Quelltext nutzen den Builder', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'lib', 'identify-v3-stage3-agentic.js'),
      'utf8'
    );
    // Kein inline-toolConfig mit allowedFunctionNames mehr ausserhalb des Builders
    const inlineForce = src.match(/allowedFunctionNames:\s*\[WRITE_TOOL\]/g) || [];
    expect(inlineForce.length).toBe(1); // nur noch im Builder selbst
    const builderUses = src.match(/buildForcedFinalizeConfig\(\)/g) || [];
    expect(builderUses.length).toBeGreaterThanOrEqual(2);
  });
});
