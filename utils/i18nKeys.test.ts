import { describe, test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

/**
 * Jeder im Code verwendete Textschlüssel MUSS in allen drei Sprachen stehen.
 *
 * `i18n.tsx` gibt bei einem unbekannten Schlüssel den SCHLÜSSEL SELBST zurück
 * (`dict[key] || key`). Fehlt ein Eintrag, liest der Mensch also z. B.
 * "error.forbidden" mitten auf dem Bildschirm — gefunden am 2026-08-16 auf dem
 * "Kein Zugriff"-Bildschirm, den ausgerechnet Mitarbeiter ohne Vollrechte
 * sehen.
 *
 * Besonders tückisch: ein Ausweichtext wie `t('x') || 'Produktname'` greift
 * NIE, weil der zurückgegebene Schlüssel eine nicht-leere Zeichenkette und
 * damit "wahr" ist. Der Fallback sieht nach Absicherung aus, ist aber keine.
 *
 * Dieser Test macht aus einem unsichtbaren Anzeigefehler einen roten Testlauf.
 */

const ROOT = path.resolve(import.meta.dirname, "..");

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx|ts)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(full);
    }
  };
  for (const dir of ["components", "hooks", "context"]) {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) walk(full);
  }
  out.push(path.join(ROOT, "App.tsx"));
  return out.filter((f) => fs.existsSync(f));
}

/** Sammelt alle t('…')-Aufrufe mit festem Schlüssel. */
function usedKeys(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.\-]+)['"]/g)) {
      if (!found.has(m[1])) found.set(m[1], path.relative(ROOT, file));
    }
  }
  return found;
}

/** Liest die drei Wörterbuch-Blöcke aus i18n.tsx über Klammer-Zählung. */
function dictionaries(): Record<"de" | "en" | "tr", Set<string>> {
  const src = fs.readFileSync(path.join(ROOT, "i18n.tsx"), "utf8");
  const result = {} as Record<"de" | "en" | "tr", Set<string>>;
  for (const lang of ["de", "en", "tr"] as const) {
    const start = new RegExp(`^\\s{2}${lang}:\\s*\\{`, "m").exec(src);
    assert.ok(start, `Wörterbuch-Block '${lang}' nicht gefunden`);
    let depth = 0;
    const from = start!.index + start![0].length - 1;
    let to = from;
    for (let i = from; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          to = i;
          break;
        }
      }
    }
    result[lang] = new Set(Array.from(src.slice(from, to).matchAll(/'([a-zA-Z0-9_.\-]+)':/g)).map((m) => m[1]));
  }
  return result;
}

describe("Übersetzungsschlüssel", () => {
  test("jeder benutzte Schlüssel existiert in allen drei Sprachen", () => {
    const used = usedKeys();
    const dicts = dictionaries();
    const fehlend: string[] = [];

    for (const [key, file] of used) {
      for (const lang of ["de", "en", "tr"] as const) {
        if (!dicts[lang].has(key)) fehlend.push(`${key} (${lang}) — benutzt in ${file}`);
      }
    }

    assert.deepStrictEqual(
      fehlend,
      [],
      `Diese Schlüssel würden dem Bediener als roher Text angezeigt:\n  ${fehlend.join("\n  ")}`
    );
  });

  test("die drei Wörterbücher tragen dieselben Schlüssel", () => {
    const dicts = dictionaries();
    const luecken: string[] = [];
    for (const lang of ["en", "tr"] as const) {
      for (const key of dicts.de) if (!dicts[lang].has(key)) luecken.push(`${key} fehlt in ${lang}`);
      for (const key of dicts[lang]) if (!dicts.de.has(key)) luecken.push(`${key} fehlt in de`);
    }
    assert.deepStrictEqual(luecken, [], `Ungleiche Wörterbücher:\n  ${luecken.join("\n  ")}`);
  });

  test("der Scanner findet überhaupt etwas (Selbstprüfung)", () => {
    assert.ok(usedKeys().size > 100, "Schlüssel-Scanner liefert verdächtig wenig — Regex kaputt?");
  });
});
