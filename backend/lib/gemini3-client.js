'use strict';

/**
 * gemini3-client.js — Central Gemini 3 client using @google/genai SDK.
 *
 * The new SDK properly supports thinking models (gemini-3-pro-preview, gemini-2.5-flash)
 * with reliable JSON structured output. The old @google/generative-ai SDK (0.24.x)
 * cannot handle thinking model responses correctly.
 *
 * Usage:
 *   const { gemini3GenerateJSON } = require('./gemini3-client');
 *   const result = await gemini3GenerateJSON({
 *     prompt: 'Estimate the weight of this product...',
 *     schema: { type: 'OBJECT', properties: { weightKg: { type: 'NUMBER' } }, required: ['weightKg'] },
 *   });
 *   // result is already parsed JSON
 */

const { getGeminiApiKey } = require('./gemini-client');
const { resolveModel } = require('./model-select');

const DEFAULT_MODEL = 'gemini-3-pro-preview';

let _clientPromise = null;

/**
 * Lazy-load the ESM-only @google/genai SDK via dynamic import.
 * Returns a GoogleGenAI instance.
 */
function getGenAIClient() {
  if (!_clientPromise) {
    _clientPromise = (async () => {
      const apiKey = await getGeminiApiKey();
      const { GoogleGenAI } = await import('@google/genai');
      return new GoogleGenAI({ apiKey });
    })();
  }
  return _clientPromise;
}

/**
 * Generate structured JSON output from Gemini.
 *
 * @param {{
 *   prompt: string,
 *   schema: object,
 *   model?: string,
 *   temperature?: number,
 *   maxOutputTokens?: number,
 * }} opts
 * @returns {Promise<object>} Parsed JSON response
 */
async function gemini3GenerateJSON({
  prompt,
  schema,
  model,
  temperature = 0.1,
  maxOutputTokens = 1024,
}) {
  const ai = await getGenAIClient();
  const modelName = resolveModel(model, 'GEMINI_MODEL', DEFAULT_MODEL);

  const response = await ai.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      temperature,
      maxOutputTokens,
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
    },
  });

  let text = (response.text || '').trim();
  if (!text) {
    throw new Error(`Gemini (${modelName}) returned empty response`);
  }

  // Safety: strip markdown fences if model wraps output
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  const jsonStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  const start = jsonStart >= 0 && (arrStart < 0 || jsonStart < arrStart) ? jsonStart : arrStart;
  if (start > 0) text = text.slice(start);

  return JSON.parse(text);
}

/**
 * Generate free-text content from Gemini.
 *
 * @param {{
 *   prompt: string,
 *   model?: string,
 *   temperature?: number,
 *   maxOutputTokens?: number,
 * }} opts
 * @returns {Promise<string>}
 */
async function gemini3GenerateText({
  prompt,
  model,
  temperature = 0.7,
  maxOutputTokens = 2048,
}) {
  const ai = await getGenAIClient();
  const modelName = resolveModel(model, 'GEMINI_MODEL', DEFAULT_MODEL);

  const response = await ai.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      temperature,
      maxOutputTokens,
    },
  });

  return (response.text || '').trim();
}

module.exports = {
  getGenAIClient,
  gemini3GenerateJSON,
  gemini3GenerateText,
  DEFAULT_MODEL,
};
