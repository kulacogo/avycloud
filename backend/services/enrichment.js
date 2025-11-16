const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { productBundleSchema } = require('../lib/product-schema');
const { getOpenAIClient } = require('../lib/openai-client');
const { uploadImage } = require('../lib/storage');
const { serpapiToolDefinition, executeSerpapiToolCall } = require('./toolkit');
const { resolveModel } = require('../lib/model-select');

const MAX_TOOL_ITERATIONS = 8;
const MAX_BARCODE_COUNT = 10000;
const MAX_IMAGE_PAYLOAD_BYTES = 25 * 1024 * 1024;
const BARCODE_LIMIT_ERROR = 'BARCODE_LIMIT_EXCEEDED';
const IMAGE_PAYLOAD_ERROR = 'IMAGE_PAYLOAD_LIMIT_EXCEEDED';
const TOOL_ITERATION_ERROR = 'TOOL_ITERATION_LIMIT';
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateProductBundle = ajv.compile(productBundleSchema);

function parseBarcodes(raw) {
  if (!raw) return [];
  const list = raw
    .split(/[\s,;|]+/)
    .map((code) => code.trim())
    .filter(Boolean);

  if (list.length > MAX_BARCODE_COUNT) {
    const error = new Error(BARCODE_LIMIT_ERROR);
    error.code = BARCODE_LIMIT_ERROR;
    error.meta = { max: MAX_BARCODE_COUNT };
    throw error;
  }
  return list;
}

async function prepareImages(files = []) {
  if (!files.length) {
    return { imageParts: [], hostedImages: [] };
  }

  const imageParts = [];
  const hostedImages = [];
  let totalBytes = 0;

  await Promise.all(
    files.map(async (file, idx) => {
      totalBytes += file.size;
      if (totalBytes > MAX_IMAGE_PAYLOAD_BYTES) {
        const error = new Error(IMAGE_PAYLOAD_ERROR);
        error.code = IMAGE_PAYLOAD_ERROR;
        throw error;
      }
      const base64 = file.buffer.toString('base64');
      const dataUrl = `data:${file.mimetype};base64,${base64}`;
      imageParts.push({
        type: 'input_image',
        image_url: dataUrl,
      });

      try {
        const publicUrl = await uploadImage(
          file.buffer,
          file.mimetype,
          'uploads',
          `identify_${Date.now()}_${idx}`
        );
        hostedImages.push({
          filename: file.originalname,
          mimeType: file.mimetype,
          url: publicUrl,
          size: file.size,
        });
      } catch (error) {
        console.warn('Failed to upload image for Lens usage:', error.message);
      }
    })
  );

  return { imageParts, hostedImages };
}

function buildSystemPrompt(locale = 'de-DE') {
  return [
    `Du bist GPT-5.1 und agierst als Product Intelligence Brain.`,
    `Pflichtregeln:`,
    `1. Nutze ausschliesslich bereitgestellte Bilder/Barcodes + SerpAPI-Toolcalls.`,
    `2. Führe mindestens einen SerpAPI-Call aus, bevor du ein Ergebnis zurückgibst.`,
    `3. Erfinde niemals Marken, Preise oder Bilder.`,
    `4. Wenn Informationen fehlen, setze das Feld leer und füge eine Notiz in notes.unsure hinzu.`,
    `5. Gib die Ausgabe strikt im ProductBundle-Schema zurück (keine Freitexte).`,
    `6. Sprich Deutsch (${locale}), Währung EUR.`,
    `7. Produktbilder nur übernehmen, wenn Quelle eindeutig verifiziert ist.`,
    `8. Nutze SerpAPI engines exakt nach Dokumentation (keine eigenen Parameter).`,
  ].join('\n');
}

function buildUserPrompt({ barcodeList, hostedImages, locale }) {
  const parts = [];
  if (barcodeList.length) {
    parts.push(`Barcodes: ${barcodeList.join(', ')}`);
  } else {
    parts.push('Barcodes: keine angegeben');
  }

  if (hostedImages.length) {
    parts.push(
      'Öffentlich abrufbare Bild-URLs (für Google Lens/Reverse Image):',
      hostedImages
        .map((img, idx) => `${idx + 1}. ${img.url} (${img.mimeType}, ${img.filename || 'upload'})`)
        .join('\n')
    );
  } else {
    parts.push('Es liegen keine vorab gehosteten Bilder vor.');
  }

  parts.push(
    `Aufgabe:`,
    `1. Analysiere die Vision-Eingaben (input_image) um Marke/Modell zu erkennen.`,
    `2. Verwende SerpAPI-Toolcalls für alle Fakten (Produktname, Preise, Händler, Bilder, Spezifikationen).`,
    `3. Nutze passende Engines: google_shopping für Preise, google_images/google_lens für Bilder, google oder duckduckgo für Texte, ebay für Marktplätze.`,
    `4. Validiere Bilder: stelle sicher, dass Links öffentlich und eindeutig sind.`,
    `5. Liefere ein vollständiges Produktdatenblatt. Attribute müssen als Liste ausgegeben werden: [{ \"key\": \"Material\", \"value\": \"100% Baumwolle\", \"value_type\": \"string\" }, ...].`,
    `6. Wenn mehrere Produkte gefunden werden, gib jedes separat im products Array mit eindeutiger id (bevorzugt EAN/GTIN) zurück.`,
    `7. pricing.lowest_price.sources benötigt echte Händler-URLs inkl. checked_at.`,
    `8. key_features >= 5, spezifisch für das Produkt.`,
    `9. images array: min. 3 Einträge sofern SerpAPI passende Quellen liefert.`,
    `10. Notiere Unsicherheiten in notes.unsure.`,
    `11. Nutze nur Informationen aus Vision, Barcodes oder SerpAPI – keine sonstigen Wissensbestände.`,
    `Sprache für Texte: Deutsch (${locale}).`
  );

  return parts.join('\n\n');
}

function assertSerpUsage(trace) {
  if (!trace.length) {
    throw new Error('SerpAPI was not used. The workflow requires at least one SerpAPI call.');
  }
}

function parseModelJson(response) {
  if (response.refusal) {
    throw new Error(`Model refusal: ${response.refusal}`);
  }
  const text = (response.output_text || '').trim();
  if (!text) {
    throw new Error('Model response did not contain output_text');
  }
  return JSON.parse(text);
}

function ensureSchema(bundle) {
  if (!validateProductBundle(bundle)) {
    const message = validateProductBundle.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ');
    throw new Error(`Model output failed ProductBundle schema validation: ${message}`);
  }
}

function normalizeBundle(bundle) {
  if (!bundle?.products) return bundle;
  bundle.products = bundle.products.map((product) => {
    const cloned = { ...product };
    if (Array.isArray(cloned.details?.attributes)) {
      const attrObj = {};
      for (const entry of cloned.details.attributes) {
        const key = entry?.key?.trim();
        if (!key) continue;
        attrObj[key] = entry?.value ?? '';
      }
      cloned.details = { ...cloned.details, attributes: attrObj };
    }
    return cloned;
  });
  return bundle;
}

async function runProductIdentification({ files = [], barcodes = '', locale = 'de-DE', modelOverride = null }) {
  if ((!files || files.length === 0) && !barcodes) {
    throw new Error('Bitte mindestens ein Bild oder einen Barcode bereitstellen.');
  }

  const barcodeList = parseBarcodes(barcodes);
  const { imageParts, hostedImages } = await prepareImages(files);
  const client = await getOpenAIClient();
  const targetModel = resolveModel(modelOverride, 'IDENTIFY_MODEL', 'gpt-5.1');
  const systemPrompt = buildSystemPrompt(locale);
  const userPrompt = buildUserPrompt({ barcodeList, hostedImages, locale });

  const inputMessages = [
    {
      role: 'system',
      content: [{ type: 'input_text', text: systemPrompt }],
    },
    {
      role: 'user',
      content: [...imageParts, { type: 'input_text', text: userPrompt }],
    },
  ];

  const serpTrace = [];
  let finalizationHintInjected = false;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let disableTools = finalizationHintInjected;
    if (!finalizationHintInjected && iteration === MAX_TOOL_ITERATIONS - 1) {
      inputMessages.push({
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'Du hast die maximale Anzahl an SerpAPI-Toolcalls erreicht. Nutze jetzt ausschließlich die bereits vorliegenden Informationen (Vision, Barcodes, vorhandene SerpAPI-Ergebnisse) und gib das vollständige ProductBundle zurück – keine weiteren Toolcalls.',
          },
        ],
      });
      finalizationHintInjected = true;
      disableTools = true;
    }

    const response = await client.responses.create({
      model: targetModel,
      input: inputMessages,
      tools: disableTools ? [] : [serpapiToolDefinition],
      reasoning: { effort: 'low' },
      text: {
        verbosity: 'medium',
        format: {
          type: 'json_schema',
          name: 'ProductBundle',
          description: 'Komplettes Produktdatenblatt laut types.ts',
          schema: productBundleSchema,
          strict: true,
        },
      },
      metadata: {
        domain: 'product-intelligence-hub',
      },
    });

    const toolCalls = response.output.filter((item) => item.type === 'function_call');
    if (!toolCalls.length) {
      const bundle = parseModelJson(response);
      ensureSchema(bundle);
      normalizeBundle(bundle);
      assertSerpUsage(serpTrace);
      return {
        bundle,
        serpTrace,
        modelResponse: response,
        modelUsed: targetModel,
      };
    }

    // Append model reasoning/tool call metadata
    inputMessages.push(...response.output);

    for (const toolCall of toolCalls) {
      const toolResult = await executeSerpapiToolCall(toolCall);
      serpTrace.push({
        engine: toolResult.engine,
        query: toolResult.query,
        summary: toolResult.summary,
        params: toolResult.params,
        error: toolResult.error || null,
      });

      inputMessages.push({
        type: 'function_call_output',
        call_id: toolCall.call_id,
        output: JSON.stringify({
          engine: toolResult.engine,
          query: toolResult.query,
          summary: toolResult.summary,
            error: toolResult.error || null,
        }),
      });
    }
  }

  const iterationError = new Error('SerpAPI/GPT workflow exceeded the maximum number of tool iterations.');
  iterationError.code = TOOL_ITERATION_ERROR;
  iterationError.serpTrace = serpTrace;
  iterationError.modelUsed = targetModel;
  throw iterationError;
}

module.exports = {
  runProductIdentification,
  BARCODE_LIMIT_ERROR,
  IMAGE_PAYLOAD_ERROR,
  MAX_BARCODE_COUNT,
  MAX_IMAGE_PAYLOAD_BYTES,
  TOOL_ITERATION_ERROR,
};

