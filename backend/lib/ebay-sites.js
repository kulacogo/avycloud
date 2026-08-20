'use strict';

/**
 * eBay-Site-Ableitung aus der viewItemUrl-Domain.
 *
 * Die Site steht NIRGENDS im GetMyeBaySelling-ActiveList-Feed — einzige
 * Quelle ist die Domain der viewItemUrl im Spiegel-Doc (empirisch 2026-07-22,
 * Sibling-Relist-Fix 59f82a4b). Diese Lib ist die EINE Quelle fuer beide
 * Verbraucher: den Stock-Sync-Dispatcher (Site-ID fuer den Trading-API-Header
 * beim Relist) und die Listing-Rows (Site-Spalte/-Filter der eBay-Seite).
 * Keine zweite Domain-Map im Repo anlegen — zwei Mechanismen fuer dieselbe
 * Frage sind eine Quelle fuer Abweichungen.
 *
 * Gemessen 2026-08-21 (3.232 aktive Listings, 100 % mit viewItemUrl):
 * ebay.de 706, ebay.it 694, benl.ebay.be 688, ebay.at 684, ebay.fr 452,
 * ebay.es 8 — die Auslands-Listings verwaltet WebInterpret auf demselben
 * Verkaeuferkonto.
 */

const EBAY_DOMAIN_TO_SITE_ID = {
  'ebay.de': '77',
  'ebay.at': '16',
  'ebay.fr': '71',
  'ebay.it': '101',
  'ebay.es': '186',
  'benl.ebay.be': '123',
  'befr.ebay.be': '23',
  'ebay.nl': '146',
  'ebay.ie': '205',
  'ebay.co.uk': '3',
  'ebay.pl': '212',
};

/**
 * Rohe Site-Domain aus einer viewItemUrl (lowercase, ohne www.), z. B.
 * 'ebay.de' oder 'benl.ebay.be'. Regex identisch zum historischen
 * resolveListingSiteId im Stock-Sync-Dispatcher. null wenn nicht ableitbar.
 */
function siteDomainFromViewItemUrl(url) {
  const m = String(url || '').match(/https?:\/\/(?:www\.)?([a-z.]*ebay\.[a-z.]+)\//i);
  return m ? m[1].toLowerCase() : null;
}

/** Trading-API-Site-ID fuer eine Domain, null wenn unbekannt. */
function siteIdForDomain(domain) {
  return EBAY_DOMAIN_TO_SITE_ID[String(domain || '').toLowerCase()] || null;
}

/**
 * Anzeige-Site fuer Listen/Filter. Belgien-Sprach-Subdomains (benl/befr)
 * werden zu 'ebay.be' kollabiert: die Subdomain sagt nicht zuverlaessig, auf
 * welcher Site das Listing ERSTELLT wurde (59f82a4b), und fuer den
 * Laender-Filter zaehlt nur das Land. Unbekannte eBay-Domains werden ehrlich
 * durchgereicht statt versteckt.
 */
function displaySiteFromViewItemUrl(url) {
  const domain = siteDomainFromViewItemUrl(url);
  if (!domain) return null;
  if (domain === 'benl.ebay.be' || domain === 'befr.ebay.be') return 'ebay.be';
  return domain;
}

module.exports = {
  EBAY_DOMAIN_TO_SITE_ID,
  siteDomainFromViewItemUrl,
  siteIdForDomain,
  displaySiteFromViewItemUrl,
};
