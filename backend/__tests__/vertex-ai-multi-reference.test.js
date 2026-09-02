/**
 * Tests für lib/vertex-ai.js — mehrere Referenzbilder + ehrliche Fehler.
 *
 * Der Kern der Beschwerde "Varianten nicht originalgetreu" sass HIER: die
 * Signatur hiess `referenceImageBase64` (Einzahl) und konnte baulich nur EIN
 * Bild transportieren. Der Aufrufer sammelte vier echte Fotos und konnte davon
 * eines abliefern.
 *
 * Zweitens: eine Weigerung des Modells war unsichtbar — finishReason,
 * promptFeedback und der Textanteil der Antwort wurden nie gelesen.
 */

const PNG = 'data:image/png;base64,AAAA';
const JPG = 'data:image/jpeg;base64,BBBB';

const {
  generateProductImages,
  generateProductImagesWithReport,
  GeminiImageError,
} = require('../lib/vertex-ai');

let calls;

function okResponse(images = [{ data: 'ZZZZ', mime: 'image/png' }]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: images.map((i) => ({ inline_data: { data: i.data, mime_type: i.mime } })) },
        },
      ],
    }),
    text: async () => '',
  };
}

beforeEach(() => {
  calls = [];
  process.env.GEMINI_API_KEY = 'test-key';
  delete process.env.GEMINI_IMAGE_MODEL;
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return okResponse();
  });
});

describe('mehrere Referenzbilder', () => {
  it('sendet JEDES uebergebene Referenzbild als eigenen inline_data-Part', async () => {
    await generateProductImages({ prompt: 'test', referenceImages: [PNG, JPG] });

    const parts = calls[0].body.contents[0].parts;
    const bilder = parts.filter((p) => p.inline_data);
    expect(bilder).toHaveLength(2);
    expect(bilder[0].inline_data.mime_type).toBe('image/png');
    expect(bilder[1].inline_data.mime_type).toBe('image/jpeg');
  });

  it('haelt die Reihenfolge ein — Bild 1 ist die Vorlage', async () => {
    await generateProductImages({ prompt: 'test', referenceImages: [PNG, JPG] });
    const bilder = calls[0].body.contents[0].parts.filter((p) => p.inline_data);
    expect(bilder[0].inline_data.data).toBe('AAAA');
  });

  it('setzt den Textteil ans ENDE, damit er sich auf die gezeigten Bilder bezieht', async () => {
    await generateProductImages({ prompt: 'mach was', referenceImages: [PNG, JPG] });
    const parts = calls[0].body.contents[0].parts;
    expect(parts[parts.length - 1].text).toBe('mach was');
  });

  it('bleibt rueckwaertskompatibel zum alten Einzelparameter', async () => {
    await generateProductImages({ prompt: 'test', referenceImageBase64: PNG });
    const bilder = calls[0].body.contents[0].parts.filter((p) => p.inline_data);
    expect(bilder).toHaveLength(1);
  });

  it('doppelt das Einzelbild nicht, wenn es auch in der Liste steht', async () => {
    await generateProductImages({ prompt: 'test', referenceImages: [PNG], referenceImageBase64: PNG });
    const bilder = calls[0].body.contents[0].parts.filter((p) => p.inline_data);
    expect(bilder).toHaveLength(1);
  });

  it('funktioniert ganz ohne Referenzbild', async () => {
    await generateProductImages({ prompt: 'test' });
    const parts = calls[0].body.contents[0].parts;
    expect(parts.filter((p) => p.inline_data)).toHaveLength(0);
    expect(parts[0].text).toBe('test');
  });

  it('meldet im Bericht, wie viele Referenzen wirklich gesendet wurden', async () => {
    const report = await generateProductImagesWithReport({
      prompt: 'test',
      referenceImages: [PNG, JPG],
    });
    expect(report.referenceCount).toBe(2);
  });
});

describe('imageConfig', () => {
  it('sendet die Zielaufloesung an ein Modell, das sie fuehrt', async () => {
    await generateProductImages({ prompt: 't', model: 'gemini-3-pro-image', imageSize: '2K' });
    expect(calls[0].body.generationConfig.imageConfig.imageSize).toBe('2K');
  });

  it('sendet KEINE Aufloesung an ein Modell, das sie nicht fuehrt', async () => {
    await generateProductImages({ prompt: 't', model: 'gemini-2.5-flash-image', imageSize: '2K' });
    expect(calls[0].body.generationConfig.imageConfig.imageSize).toBeUndefined();
  });

  it('rechnet einen toten Modellnamen vor dem Aufruf auf den Nachfolger um', async () => {
    await generateProductImages({ prompt: 't', model: 'gemini-3-pro-image-preview' });
    expect(calls[0].url).toContain('gemini-3-pro-image:generateContent');
    expect(calls[0].url).not.toContain('preview');
  });
});

describe('Weigerungen werden sichtbar', () => {
  it('erkennt eine blockierte Anfrage', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }),
      text: async () => '',
    }));
    await expect(generateProductImages({ prompt: 't' })).rejects.toThrow(/blockiert.*SAFETY/i);
  });

  it('erkennt eine Antwort mit Text statt Bild — frueher ein stilles leeres Array', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Das kann ich nicht.' }] } }],
      }),
      text: async () => '',
    }));
    await expect(generateProductImages({ prompt: 't' })).rejects.toThrow(/Text statt.*Bild/i);
  });

  it('reicht finishReason durch, wenn das Modell ohne Bild abbricht', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ finishReason: 'NO_IMAGE', content: { parts: [] } }] }),
      text: async () => '',
    }));
    await expect(generateProductImages({ prompt: 't' })).rejects.toThrow(/NO_IMAGE/);
  });

  it('traegt eine maschinenlesbare Fehlerklasse', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: { message: 'overloaded' } }),
    }));
    let fehler;
    try {
      await generateProductImages({ prompt: 't', maxAttempts: 1 });
    } catch (err) {
      fehler = err;
    }
    expect(fehler).toBeInstanceOf(GeminiImageError);
    expect(fehler.code).toBe('HTTP_503');
    expect(fehler.retryable).toBe(true);
  });
});

describe('Wiederholungen', () => {
  it('wiederholt einen voruebergehenden Fehler und liefert danach das Bild', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      n += 1;
      if (n === 1) return { ok: false, status: 429, text: async () => 'rate limited' };
      return okResponse();
    });

    const report = await generateProductImagesWithReport({ prompt: 't', maxAttempts: 3 });
    expect(report.images).toHaveLength(1);
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts[0].ok).toBe(false);
    expect(report.attempts[1].ok).toBe(true);
  });

  it('wiederholt einen NICHT wiederholbaren Fehler nicht', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return { ok: false, status: 400, text: async () => 'bad request' };
    });
    await expect(generateProductImages({ prompt: 't', maxAttempts: 3 })).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });
});

describe('Zeitgrenze', () => {
  it('bricht ab statt unbegrenzt zu haengen — der Default ist NICHT mehr 0', async () => {
    globalThis.fetch = vi.fn((url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })
    );
    await expect(
      generateProductImages({ prompt: 't', timeoutMs: 40, maxAttempts: 1 })
    ).rejects.toThrow(/abgebrochen/i);
  });
});
