#!/usr/bin/env node
'use strict';
// READ-ONLY Probe (2026-08-02): Verifiziert gegen die ECHTE Gemini-API, wie
// grounded Calls (googleSearch) auf gemini-2.5 zuverlässig strukturiertes
// JSON liefern. Kein Firestore, keine Writes — nur API-Calls + stdout.
// Aufruf: GEMINI_API_KEY=... node scripts/probe-gemini25-grounded-json.js

const { GoogleGenAI } = require('@google/genai');

const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY fehlt'); process.exit(1); }

const ai = new GoogleGenAI({ apiKey: KEY });
const MODEL = process.env.PROBE_MODEL || 'gemini-2.5-flash';

const SCHEMA = {
  type: 'object',
  properties: {
    brand: { type: 'string' },
    model: { type: 'string' },
    ean: { type: 'string' },
    category_path: { type: 'string' },
  },
  required: ['brand', 'model'],
};

const PROMPT = [
  'Identifiziere das Produkt mit EAN 5025155096772 (Dyson WashG1 Nass-Bodenreiniger).',
  'Nutze Google Search zur Verifikation.',
  'Antworte AUSSCHLIESSLICH mit einem JSON-Objekt: {"brand","model","ean","category_path"}.',
  'Kein Text vor oder nach dem JSON.',
].join('\n');

function tryParse(text) {
  let t = String(text || '').trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  const start = t.indexOf('{');
  if (start > 0) t = t.slice(start);
  const end = t.lastIndexOf('}');
  if (end > 0) t = t.slice(0, end + 1);
  try { return JSON.parse(t); } catch { return null; }
}

(async () => {
  // A: grounded, OHNE JSON-Zwang (heutiger Prod-Zustand nach Strip)
  console.log('--- A: tools, kein responseMimeType ---');
  const a = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
    config: {
      tools: [{ googleSearch: {} }],
      temperature: 0.4,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 2048, includeThoughts: false },
      httpOptions: { timeout: 60000 },
    },
  });
  const aText = a.text || '';
  console.log('A länge:', aText.length, '| erste 200:', JSON.stringify(aText.slice(0, 200)));
  console.log('A parsebar:', tryParse(aText) ? 'JA' : 'NEIN');

  // B: Zweitcall OHNE tools, MIT Schema — formt A-Text in striktes JSON
  console.log('--- B: Formatter (kein Tool, responseJsonSchema) ---');
  const b = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: `Extrahiere die Produktdaten aus folgendem Text als JSON gemäß Schema. Text:\n\n${aText || '(leer)'}` }] }],
    config: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseJsonSchema: SCHEMA,
      httpOptions: { timeout: 30000 },
    },
  });
  const bText = b.text || '';
  console.log('B länge:', bText.length, '| roh:', JSON.stringify(bText.slice(0, 300)));
  console.log('B parsebar:', tryParse(bText) ? 'JA' : 'NEIN');
  process.exit(0);
})().catch((e) => { console.error('PROBE-FEHLER:', e?.message || e); process.exit(1); });
