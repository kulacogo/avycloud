'use strict';

const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const dns = require('dns');
const { assertPublicHost, isPrivateIp } = require('./ssrf-guard');

// Check the addresses used by the connection as well as the initial URL.
// No credentials, cookies or internal destinations; every redirect is checked.
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses?.length || addresses.some(row => isPrivateIp(row.address))) {
      return callback(new Error('Research destination is not public'));
    }
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

async function researchDownload(input, { image = false, deadline = Date.now() + 12000 } = {}) {
  let target = input;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(12000, deadline - Date.now())));
  try {
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      if (Date.now() >= deadline) throw new Error('Research deadline reached');
      const url = await assertPublicHost(target);
      if (url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Research URL credentials/port rejected');
      const agent = url.protocol === 'https:' ? new https.Agent({ lookup: publicLookup }) : new http.Agent({ lookup: publicLookup });
      try {
        const response = await fetch(url.href, {
          redirect: 'manual', signal: controller.signal, agent,
          size: image ? 12 * 1024 * 1024 : 2 * 1024 * 1024,
          headers: { 'User-Agent': 'AvyCloud-ProductResearch/1.0', Accept: image ? 'image/*' : 'text/html,application/xhtml+xml' },
        });
        if (response.status >= 300 && response.status < 400) {
          response.body.destroy();
          target = new URL(response.headers.get('location'), url).href;
          continue;
        }
        const mimeType = (response.headers.get('content-type') || '').split(';')[0];
        if (!response.ok || !(image ? /^image\/(jpeg|png|webp|avif)$/i.test(mimeType) : /^(text\/html|application\/xhtml\+xml)$/i.test(mimeType))) {
          response.body.destroy();
          throw new Error('Research source unavailable or unsupported');
        }
        const buffer = await response.buffer();
        return { url: url.href, mimeType, buffer, body: image ? undefined : buffer.toString('utf8') };
      } finally { agent.destroy(); }
    }
    throw new Error('Too many research redirects');
  } finally { clearTimeout(timer); }
}

module.exports = { researchDownload, publicLookup };
