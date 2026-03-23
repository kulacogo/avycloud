'use strict';

function buildGroupingPrompt(imageCount) {
  return [
    'Du bist ein Bildanalyse-Experte für Produktfotos in einem E-Commerce-Warenlager.',
    '',
    `Dir werden ${imageCount} Bilder gezeigt. Deine Aufgabe:`,
    '1. Erkenne wie viele VERSCHIEDENE Produkte in den Bildern zu sehen sind.',
    '2. Gruppiere die Bilder nach Produkten.',
    '3. WICHTIG: Ein einzelnes Bild kann MEHRERE Produkte zeigen (z.B. Palette, Tisch mit Ware, Regal).',
    '   In dem Fall ordne das Bild ALLEN Gruppen zu, deren Produkt darauf sichtbar ist.',
    '',
    'STRENGE REGELN:',
    '- Zähle NUR Produkte die du auf den Bildern KLAR SIEHST.',
    '- Erfinde KEINE Produkte. Im Zweifel: alles in EINE Gruppe.',
    '- Mehrere Ansichten desselben Produkts (Vorne, Hinten, Seite, Detail) = EINE Gruppe.',
    '- Unterschiedliche Farben/Varianten desselben Modells = EINE Gruppe.',
    '- Nur wenn Marke ODER Produkttyp ODER Form klar unterschiedlich → separate Gruppe.',
    '- Falls ein Bild einen Barcode/EAN zeigt: notiere ihn bei der Gruppe.',
    '- Ein Bild darf in MEHREREN Gruppen vorkommen wenn es mehrere Produkte zeigt.',
    '- Übersichtsfotos (mehrere Produkte auf einem Bild) gehören zu JEDER dort sichtbaren Gruppe.',
    '- Nie mehr Gruppen als Bilder.',
    '',
    'Antworte NUR mit JSON (kein Markdown, kein Kommentar):',
    '{',
    '  "product_count": <Zahl>,',
    '  "groups": [',
    '    {',
    '      "label": "Produkt 1",',
    '      "image_indices": [0, 2, 4],',
    '      "confidence": 0.95,',
    '      "reason": "Gleiche Nike Schachtel von drei Seiten",',
    '      "detected_barcode": "4006381333931"',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

function parseGroupingResponse(rawResponse, imageCount) {
  let text = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
  // Gemini may wrap JSON in markdown code blocks
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) text = jsonMatch[1].trim();

  const parsed = JSON.parse(text);
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];

  return groups
    .filter((g) => Array.isArray(g.image_indices) && g.image_indices.length > 0)
    .map((g, idx) => ({
      id: `group_${idx}`,
      label: g.label || `Produkt ${idx + 1}`,
      image_indices: g.image_indices.filter(
        (i) => typeof i === 'number' && i >= 0 && i < imageCount
      ),
      confidence:
        typeof g.confidence === 'number'
          ? Math.min(1, Math.max(0, g.confidence))
          : 0.5,
      reason: typeof g.reason === 'string' ? g.reason : '',
      detected_barcode:
        typeof g.detected_barcode === 'string' && g.detected_barcode.trim()
          ? g.detected_barcode.trim()
          : null,
    }))
    .filter((g) => g.image_indices.length > 0);
}

module.exports = { buildGroupingPrompt, parseGroupingResponse };
