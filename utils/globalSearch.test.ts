import { describe, test, beforeEach } from "node:test";
import assert from "node:assert";
import {
  publishGlobalSearch,
  subscribeGlobalSearch,
  readInitialGlobalSearch,
  GLOBAL_SEARCH_STORAGE_KEY,
} from "./globalSearch.ts";

/**
 * Die Suche oben in der Leiste legte den Begriff nur in den Sitzungsspeicher
 * und navigierte auf "Produkte". Die Produkttabelle liest diesen Speicher aber
 * NUR beim ersten Aufbau. Stand man schon auf "Produkte", passierte deshalb
 * gar nichts: das Feld leerte sich, die Liste blieb unverändert.
 *
 * Ein Speicher-Schlüssel ist eben keine Benachrichtigung.
 */
function fakeSessionStorage() {
  const daten = new Map<string, string>();
  return {
    getItem: (k: string) => (daten.has(k) ? daten.get(k)! : null),
    setItem: (k: string, v: string) => void daten.set(k, v),
    removeItem: (k: string) => void daten.delete(k),
  };
}

beforeEach(() => {
  (globalThis as any).sessionStorage = fakeSessionStorage();
});

describe("globale Suche", () => {
  test("ein bereits lauschender Empfänger bekommt den Begriff sofort", () => {
    const empfangen: string[] = [];
    const stop = subscribeGlobalSearch((term) => empfangen.push(term));

    publishGlobalSearch("bosch akkuschrauber");

    assert.deepStrictEqual(empfangen, ["bosch akkuschrauber"]);
    stop();
  });

  test("der Begriff überlebt auch für einen erst später aufgebauten Empfänger", () => {
    publishGlobalSearch("makita");
    assert.strictEqual(readInitialGlobalSearch(), "makita");
  });

  test("abgemeldete Empfänger bekommen nichts mehr", () => {
    const empfangen: string[] = [];
    const stop = subscribeGlobalSearch((term) => empfangen.push(term));
    stop();

    publishGlobalSearch("hilti");

    assert.deepStrictEqual(empfangen, []);
  });

  test("mehrere Empfänger werden alle bedient", () => {
    const a: string[] = [];
    const b: string[] = [];
    const stopA = subscribeGlobalSearch((t) => a.push(t));
    const stopB = subscribeGlobalSearch((t) => b.push(t));

    publishGlobalSearch("festool");

    assert.deepStrictEqual(a, ["festool"]);
    assert.deepStrictEqual(b, ["festool"]);
    stopA();
    stopB();
  });

  test("der Begriff landet unter dem Schlüssel, den die Produkttabelle liest", () => {
    publishGlobalSearch("dewalt");
    assert.strictEqual((globalThis as any).sessionStorage.getItem(GLOBAL_SEARCH_STORAGE_KEY), "dewalt");
  });

  test("ohne Sitzungsspeicher wird trotzdem zugestellt statt zu werfen", () => {
    delete (globalThis as any).sessionStorage;
    const empfangen: string[] = [];
    const stop = subscribeGlobalSearch((t) => empfangen.push(t));

    assert.doesNotThrow(() => publishGlobalSearch("ohne speicher"));

    assert.deepStrictEqual(empfangen, ["ohne speicher"]);
    assert.strictEqual(readInitialGlobalSearch(), "");
    stop();
  });
});
