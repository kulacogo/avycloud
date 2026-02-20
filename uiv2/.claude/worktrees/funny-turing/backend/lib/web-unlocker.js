const fetch = require('node-fetch');
const { getSecretValue } = require('./secret-values');

const DEFAULT_ENDPOINT = process.env.BRIGHTDATA_ENDPOINT || 'https://api.brightdata.com/request';
const DEFAULT_ZONE =
  process.env.BRIGHTDATA_ZONE ||
  process.env.BRIGHTDATA_DEFAULT_ZONE ||
  // AvyCloud default (per Bright Data control panel zone)
  'unlocker_avy';
const DEFAULT_FORMAT = process.env.BRIGHTDATA_FORMAT || 'raw';
const DEFAULT_COUNTRY = process.env.BRIGHTDATA_COUNTRY || null;
const DEFAULT_TIMEOUT_MS = parseInt(process.env.BRIGHTDATA_TIMEOUT_MS || '30000', 10);
const MAX_TEXT_BYTES = parseInt(process.env.BRIGHTDATA_MAX_TEXT_BYTES || '200000', 10);

let cachedToken = null;

async function getBrightDataToken() {
  if (cachedToken) return cachedToken;
  const envToken = process.env.BRIGHTDATA_API_TOKEN;
  if (envToken) {
    cachedToken = envToken;
    return cachedToken;
  }
  const secret = await getSecretValue('BRIGHTDATA_API_TOKEN');
  if (!secret) {
    throw new Error('BRIGHTDATA_API_TOKEN is not configured');
  }
  cachedToken = secret;
  return cachedToken;
}

function sanitizeHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object') return undefined;
  const result = {};
  Object.entries(headers).forEach(([key, value]) => {
    if (!key) return;
    if (value === undefined || value === null) return;
    result[String(key)] = String(value);
  });
  return Object.keys(result).length ? result : undefined;
}

async function fetchWithUnlocker({
  url,
  method = 'GET',
  headers = undefined,
  body = undefined,
  zone = DEFAULT_ZONE,
  format = DEFAULT_FORMAT,
  dataFormat = null,
  country = DEFAULT_COUNTRY,
  mobile = false,
  expect = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!url) {
    throw new Error('URL is required for Bright Data Web Unlocker');
  }
  if (!zone) {
    throw new Error('BRIGHTDATA_ZONE is not configured');
  }
  const token = await getBrightDataToken();
  const payload = {
    zone,
    url,
    method: method.toUpperCase(),
    format,
  };
  if (body && typeof body === 'string') {
    payload.body = body;
  }
  const sanitizedHeaders = sanitizeHeaders(headers);
  if (sanitizedHeaders) {
    payload.headers = sanitizedHeaders;
  }
  if (expect && typeof expect === 'object') {
    const expectation = {};
    if (expect.element) expectation.element = expect.element;
    if (expect.text) expectation.text = expect.text;
    if (Object.keys(expectation).length) {
      payload.headers = {
        ...(payload.headers || {}),
        'x-unblock-expect': JSON.stringify(expectation),
      };
    }
  }
  if (country) {
    payload.country = country;
  }
  if (mobile) {
    payload.ua = 'mobile';
  }
  if (dataFormat) {
    payload.data_format = dataFormat;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(DEFAULT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || '';
    const rawHeaders = {};
    response.headers.forEach((value, key) => {
      rawHeaders[key] = value;
    });

    const buffer = await response.buffer();
    const isBinary =
      dataFormat === 'screenshot' || /^image\//i.test(contentType || '');

    let bodyText = null;
    let bodyBase64 = null;
    if (isBinary) {
      bodyBase64 = buffer.toString('base64');
    } else {
      bodyText = buffer.toString('utf8');
      if (bodyText.length > MAX_TEXT_BYTES) {
        bodyText = bodyText.slice(0, MAX_TEXT_BYTES);
      }
    }

    const success = response.ok;

    return {
      success,
      url,
      status: response.status,
      statusText: response.statusText,
      headers: rawHeaders,
      contentType,
      body: bodyText,
      body_base64: bodyBase64,
      bytes: buffer.length,
      dataFormat: dataFormat || null,
      format,
      zone,
    };
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error('Web Unlocker request timed out');
    }
    throw error;
  }
}

module.exports = {
  fetchWithUnlocker,
};


