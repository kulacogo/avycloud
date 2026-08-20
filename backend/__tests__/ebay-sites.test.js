'use strict';

// globals: true in vitest.config.js — describe/it/expect sind global.
//
// Site-Ableitung aus der viewItemUrl-Domain (lib/ebay-sites.js) — die EINE
// Quelle fuer Dispatcher-Site-ID (Relist-Header) und die Site-Spalte/-Filter
// der eBay-Listings-Seite. Gemessen 2026-08-21: 100 % der 3.232 aktiven
// Listings tragen eine viewItemUrl; nur 706 davon sind ebay.de.

const {
  EBAY_DOMAIN_TO_SITE_ID,
  siteDomainFromViewItemUrl,
  siteIdForDomain,
  displaySiteFromViewItemUrl,
} = require('../lib/ebay-sites');

describe('siteDomainFromViewItemUrl', () => {
  it('extrahiert die Domain lowercase und ohne www.', () => {
    expect(siteDomainFromViewItemUrl('https://www.ebay.de/itm/800539945637')).toBe('ebay.de');
    expect(siteDomainFromViewItemUrl('https://www.eBay.IT/itm/123')).toBe('ebay.it');
    expect(siteDomainFromViewItemUrl('http://ebay.fr/itm/9')).toBe('ebay.fr');
  });

  it('behaelt Sprach-Subdomains (Belgien) im Rohwert — der Dispatcher braucht benl/befr fuer die Site-ID', () => {
    expect(siteDomainFromViewItemUrl('https://benl.ebay.be/itm/800470124992')).toBe('benl.ebay.be');
    expect(siteDomainFromViewItemUrl('https://befr.ebay.be/itm/1')).toBe('befr.ebay.be');
  });

  it('null bei leer/kaputt/fremd', () => {
    expect(siteDomainFromViewItemUrl('')).toBe(null);
    expect(siteDomainFromViewItemUrl(null)).toBe(null);
    expect(siteDomainFromViewItemUrl('kein-link')).toBe(null);
    expect(siteDomainFromViewItemUrl('https://example.com/itm/1')).toBe(null);
  });
});

describe('siteIdForDomain', () => {
  it('mappt die Trading-API-Site-IDs (identisch zur historischen Dispatcher-Map)', () => {
    expect(siteIdForDomain('ebay.de')).toBe('77');
    expect(siteIdForDomain('ebay.at')).toBe('16');
    expect(siteIdForDomain('benl.ebay.be')).toBe('123');
    expect(siteIdForDomain('befr.ebay.be')).toBe('23');
    expect(siteIdForDomain('EBAY.DE')).toBe('77');
  });

  it('null fuer unbekannte Domains', () => {
    expect(siteIdForDomain('ebay.com')).toBe(null);
    expect(siteIdForDomain(null)).toBe(null);
  });
});

describe('displaySiteFromViewItemUrl', () => {
  it('kollabiert die Belgien-Sprach-Subdomains zu ebay.be', () => {
    expect(displaySiteFromViewItemUrl('https://benl.ebay.be/itm/1')).toBe('ebay.be');
    expect(displaySiteFromViewItemUrl('https://befr.ebay.be/itm/1')).toBe('ebay.be');
  });

  it('liefert bekannte Sites unveraendert', () => {
    expect(displaySiteFromViewItemUrl('https://www.ebay.de/itm/1')).toBe('ebay.de');
    expect(displaySiteFromViewItemUrl('https://www.ebay.es/itm/1')).toBe('ebay.es');
  });

  it('reicht unbekannte eBay-Domains ehrlich durch statt sie zu verstecken', () => {
    expect(displaySiteFromViewItemUrl('https://www.ebay.com/itm/1')).toBe('ebay.com');
  });

  it('null ohne ableitbare Domain', () => {
    expect(displaySiteFromViewItemUrl(null)).toBe(null);
    expect(displaySiteFromViewItemUrl('https://example.com/x')).toBe(null);
  });
});

describe('Dispatcher-Delegation (Source-Gate)', () => {
  const fs = require('fs');
  const path = require('path');

  it('stock-sync-dispatcher fuehrt KEINE eigene Domain-Map mehr — eine Quelle (lib/ebay-sites)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'stock-sync-dispatcher.js'), 'utf8');
    expect(source).toContain("require('../lib/ebay-sites')");
    // Die Map darf dort nicht mehr als Literal definiert sein:
    expect(source).not.toMatch(/EBAY_DOMAIN_TO_SITE_ID\s*=\s*\{/);
  });

  it('listLiveListings haengt site an die Row (Site-Spalte/-Filter der eBay-Seite)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ebay-direct.js'), 'utf8');
    expect(source).toContain('displaySiteFromViewItemUrl');
    const start = source.indexOf('async function listLiveListings');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 12000);
    expect(body).toMatch(/site:\s*displaySiteFromViewItemUrl\(/);
  });
});
