const { callSerpApi, summarizeSerpEntries, ALLOWED_ENGINES } = require('../lib/serpapi');

const serpapiToolDefinition = {
  type: 'function',
  name: 'serpapi_web_search',
  description: 'Fetches REAL-TIME product data via SerpAPI using official engines only.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      engine: {
        type: 'string',
        enum: [
          'google',
          'google_shopping',
          'google_images',
          'google_lens',
          'google_reverse_image',
          'bing',
          'bing_images',
          'duckduckgo',
          'yahoo',
          'yandex',
          'ebay',
          'walmart',
          'home_depot',
          'naver',
        ],
      },
      query: { type: 'string' },
      num: { type: ['number', 'null'], minimum: 1, maximum: 100, default: null },
    },
    required: ['engine', 'query', 'num'],
    additionalProperties: false,
  },
};

function buildSerpParams(engine, query, num) {
  const trimmed = (query || '').trim();
  if (!trimmed) {
    throw new Error('SerpAPI query is required');
  }

  const params = {};
  if (engine === 'google_lens') {
    params.url = trimmed;
    params.type = 'products';
  } else if (engine === 'google_reverse_image') {
    params.image_url = trimmed;
  } else {
    params.q = trimmed;
  }

  if (num) {
    params.num = Math.min(Math.max(1, Math.floor(num)), 50);
  }

  return params;
}

async function executeSerpapiToolCall(toolCall) {
  const args = JSON.parse(toolCall.arguments || '{}');
  const { engine, query, num } = args;

  if (!ALLOWED_ENGINES.includes(engine)) {
    throw new Error(`Engine ${engine} is not supported by SerpAPI tool`);
  }

  const params = buildSerpParams(engine, query, num);
  try {
    const raw = await callSerpApi(engine, params);
    const summary = summarizeSerpEntries(engine, raw, 8);

    return {
      engine,
      query,
      params,
      summary,
      raw,
    };
  } catch (error) {
    return {
      engine,
      query,
      params,
      summary: [],
      raw: null,
      error: error.message || String(error),
    };
  }
}

module.exports = {
  serpapiToolDefinition,
  executeSerpapiToolCall,
};

