const { getOpenAIClient } = require('../lib/openai-client');
const { serpapiToolDefinition, executeSerpapiToolCall } = require('./toolkit');
const { resolveModel } = require('../lib/model-select');

const MAX_CHAT_ITERATIONS = 5;

const updateDatasheetTool = {
  type: 'function',
  name: 'update_product_datasheet',
  description: 'Propose structured changes to the currently visible product datasheet. Do not persist automatically – the user must confirm.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      short_description: { type: 'string' },
      key_features: {
        type: 'array',
        items: { type: 'string' },
      },
      attributes: {
        type: 'array',
        items: {
          type: 'object',
          required: ['key', 'value', 'value_type'],
          additionalProperties: false,
          properties: {
            key: { type: 'string' },
            value: { type: ['string', 'number', 'boolean'] },
            value_type: {
              type: 'string',
              enum: ['string', 'number', 'boolean'],
              default: 'string',
            },
          },
        },
      },
      pricing: {
        type: 'object',
        additionalProperties: false,
        required: ['lowest_price', 'price_confidence'],
        properties: {
          lowest_price: {
            type: 'object',
            additionalProperties: false,
            required: ['amount', 'currency', 'sources', 'last_checked_iso'],
            properties: {
              amount: { type: 'number' },
              currency: { type: 'string' },
              sources: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['name', 'url', 'price', 'shipping', 'checked_at'],
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string' },
                    url: { type: 'string' },
                    price: { type: ['number', 'null'] },
                    shipping: { type: ['number', 'null'] },
                    checked_at: { type: ['string', 'null'] },
                  },
                },
              },
              last_checked_iso: { type: ['string', 'null'] },
            },
          },
          price_confidence: { type: 'number' },
        },
      },
      notes: {
        type: 'object',
        additionalProperties: false,
        required: ['unsure', 'warnings'],
        properties: {
          unsure: {
            type: 'array',
            items: { type: 'string' },
          },
          warnings: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
    additionalProperties: false,
  },
};

const suggestImagesTool = {
  type: 'function',
  name: 'suggest_product_images',
  description: 'Provide marketing-ready image URLs for the current product.',
  parameters: {
    type: 'object',
    properties: {
      rationale: { type: 'string' },
      images: {
        type: 'array',
        items: {
          type: 'object',
          required: ['url', 'source', 'variant', 'notes'],
          additionalProperties: false,
          properties: {
            url: { type: 'string' },
            source: { type: 'string' },
            variant: { type: 'string' },
            notes: { type: 'string' },
          },
        },
      },
    },
    required: ['images'],
  },
};

function attributeArrayToObject(entries = []) {
  if (!Array.isArray(entries)) return {};
  return entries.reduce((acc, entry) => {
    if (!entry?.key) return acc;
    acc[entry.key] = entry.value ?? '';
    return acc;
  }, {});
}

function buildSystemPrompt() {
  return [
    'Du bist ein Product-Intelligence-Assistent. Kontext: E-Commerce Datasheets.',
    'Regeln:',
    '1. Verwende SerpAPI nur über das bereitgestellte Tool.',
    '2. Gib keine Persistenz-Anweisungen – Änderungen werden erst nach Nutzerzustimmung übernommen.',
    '3. Alle Preise in EUR, alle Texte auf Deutsch.',
    '4. Für Bilder nur öffentlich erreichbare URLs, keine Platzhalter.',
    '5. Wenn keine Ergebnisse gefunden werden, sag das explizit.',
  ].join('\n');
}

function buildUserPrompt(product, message) {
  return [
    `Produktdaten (JSON):\n${JSON.stringify(product, null, 2)}`,
    `Nutzeranfrage: ${message}`,
    `Du kannst \`update_product_datasheet\` nutzen, um neue Werte vorzuschlagen, und \`suggest_product_images\`, um Bild-URLs zu liefern.`,
  ].join('\n\n');
}

function sanitizeImageSuggestions(entry) {
  if (!Array.isArray(entry?.images)) return [];
  return entry.images
    .filter((img) => typeof img.url === 'string' && img.url.startsWith('http'))
    .map((img) => ({
      url_or_base64: img.url,
      source: img.source || 'web',
      variant: img.variant || 'other',
      notes: img.notes || 'Vorschlag aus GPT-Chat',
    }));
}

function sanitizeDatasheetChange(entry) {
  const result = {};
  if (entry.summary) result.summary = entry.summary;
  if (entry.short_description) result.short_description = entry.short_description;
  if (Array.isArray(entry.key_features)) {
    result.key_features = entry.key_features.filter(Boolean);
  }
  if (Array.isArray(entry.attributes)) {
    result.attributes = attributeArrayToObject(entry.attributes);
  }
  if (entry.pricing) {
    result.pricing = entry.pricing;
  }
  if (entry.notes) {
    result.notes = entry.notes;
  }
  return result;
}

async function runProductChat(product, userMessage, { modelOverride = null } = {}) {
  const client = await getOpenAIClient();
  const targetModel = resolveModel(modelOverride, 'CHAT_MODEL', 'gpt-5.1');
  const inputMessages = [
    {
      role: 'system',
      content: [{ type: 'input_text', text: buildSystemPrompt() }],
    },
    {
      role: 'user',
      content: [{ type: 'input_text', text: buildUserPrompt(product, userMessage) }],
    },
  ];

  const datasheetChanges = [];
  const imageSuggestions = [];
  const serpTrace = [];

  for (let iteration = 0; iteration < MAX_CHAT_ITERATIONS; iteration++) {
    const response = await client.responses.create({
      model: targetModel,
      input: inputMessages,
      tools: [serpapiToolDefinition, updateDatasheetTool, suggestImagesTool],
      reasoning: { effort: 'none' },
      text: { verbosity: 'medium' },
    });

    const toolCalls = response.output.filter((item) => item.type === 'function_call');
    if (!toolCalls.length) {
      return {
        message: response.output_text?.trim() || 'Keine Antwort erhalten.',
        datasheetChanges,
        imageSuggestions,
        serpTrace,
        modelUsed: targetModel,
      };
    }

    inputMessages.push(...response.output);

    for (const toolCall of toolCalls) {
      let toolResult = null;
      if (toolCall.name === 'serpapi_web_search') {
        const result = await executeSerpapiToolCall(toolCall);
        serpTrace.push({
          engine: result.engine,
          query: result.query,
          summary: result.summary,
          error: result.error || null,
        });
        toolResult = {
          summary: result.summary,
          error: result.error || null,
        };
      } else if (toolCall.name === 'update_product_datasheet') {
        const args = JSON.parse(toolCall.arguments || '{}');
        const sanitized = sanitizeDatasheetChange(args);
        datasheetChanges.push(sanitized);
        toolResult = { acknowledged: true, applied_fields: Object.keys(sanitized) };
      } else if (toolCall.name === 'suggest_product_images') {
        const args = JSON.parse(toolCall.arguments || '{}');
        const sanitized = sanitizeImageSuggestions(args);
        if (sanitized.length) {
          imageSuggestions.push({
            rationale: args.rationale || '',
            images: sanitized,
          });
        }
        toolResult = { acknowledged: true, count: sanitized.length };
      } else {
        toolResult = { error: `Unknown tool ${toolCall.name}` };
      }

      inputMessages.push({
        type: 'function_call_output',
        call_id: toolCall.call_id,
        output: JSON.stringify(toolResult),
      });
    }
  }

  const err = new Error('Chat workflow exceeded maximum number of tool iterations.');
  err.modelUsed = targetModel;
  throw err;
}

module.exports = {
  runProductChat,
};

