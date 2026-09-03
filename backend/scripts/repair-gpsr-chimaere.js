#!/usr/bin/env node
/**
 * Räumt die GPSR-Chimären auf: zusammengesetzte Herstelleranschriften, deren
 * Teile aus verschiedenen Firmen stammen, und die Registry-Einträge, die sie
 * bei jedem Speichern UND jedem Laden über die Produkte legen.
 *
 * VORFALL 2026-09-03 (Produkt 371fce64 / SKU-1698488489, Marke "BBQ-Toro"):
 * Der Chat recherchierte um 20:15 UTC die richtigen Herstellerangaben
 * (CS-Trading GmbH & Co. KG, Moselweinstraße 55, 54472 Brauneberg) und schrieb
 * sie ins Datenblatt. 400 ms später überschrieb der Registry-Enforce in
 * `lib/firestore.js` sie mit `gpsrManufacturers/bbq-toro` — Straße aus
 * CS-Trading, Ort/PLZ/Telefon aus Kirchheim unter Teck, Sitzland "China", dazu
 * die unbeteiligte Geaplan GmbH als EU-Verantwortlicher. Acht Minuten später
 * schrieb ein manueller Save den verdorbenen Block mit overwrite:true in die
 * Registry ZURÜCK. Belegt durch `ops.data_quality.gpsr_backup_v1` am Produkt.
 *
 * Die Ursache ist im Code behoben (lib/gpsr-enforce-guard.js: Anschrift nur als
 * Ganzes, widersprüchliche Einträge werden nicht durchgesetzt, besser belegte
 * Produktdaten gewinnen). Dieses Script räumt den ALTBESTAND auf.
 *
 * WAS ES BEWUSST NICHT TUT: den richtigen Hersteller raten. Es stellt nur
 * wieder her, was NACHWEISLICH vorher am Produkt stand (gpsr_backup_v1.before,
 * vom Enforce selbst geschrieben), und entwertet Registry-Einträge, die sich
 * selbst widersprechen. Ein leeres Feld ist besser als ein erfundenes.
 *
 * REIHENFOLGE IST WICHTIG: erst die Registry entwerten, dann die Produkte.
 * Andersherum würde der Enforce-/Lese-Pfad die frisch reparierten Produkte
 * sofort wieder überschreiben.
 *
 * Aufruf (read-only ist Default, schreibt NIE ohne beides):
 *   node backend/scripts/repair-gpsr-chimaere.js
 *   node backend/scripts/repair-gpsr-chimaere.js --sku SKU-1698488489
 *   node backend/scripts/repair-gpsr-chimaere.js --eu-rep-aufraeumen
 *   node backend/scripts/repair-gpsr-chimaere.js --apply --confirm GPSR_CHIMAERE_V1
 *
 * SCHREIBWEG: gezielte `update()`-Aufrufe auf `details.gpsr.*` und
 * `ops.data_quality.*`. Bewusst NICHT `saveProductV2` — das ist ein MERGE
 * (kann keine Map-Schlüssel entfernen) und würde bei dreistelligen Produkt-
 * zahlen Titel-, Kategorie- und Marktplatz-Normalisierungen mitauslösen.
 * Bestand, Preise und Listings werden nicht angefasst.
 */

'use strict';

process.env.USE_PRODUCTS_V2 = process.env.USE_PRODUCTS_V2 || 'true';
// Lokale gcloud-Installationen zeigen auf ein FREMDES Projekt — Projekt hier
// festnageln, BEVOR irgendein Firestore-Client geladen wird.
process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;

const fsNode = require('fs');
const path = require('path');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const {
  findGpsrInconsistencies,
  isInternallyConsistentGpsr,
  declaredCountryCode,
  EU_COUNTRY_CODES,
} = require('../lib/gpsr-enforce-guard');

const CONFIRM_TOKEN = 'GPSR_CHIMAERE_V1';
const TENANT = process.env.TENANT_ID || 'default';
const PRODUCTS = 'products_v2';
const REGISTRY = 'gpsrManufacturers';

// Felder des Hersteller-Blocks, die aus `gpsr_backup_v1.before` wieder-
// hergestellt werden. `eu_responsible_*` bewusst NICHT: der Backup-Stand trug
// den fremden EU-Vertreter bereits, dafür gibt es --eu-rep-aufraeumen.
const RESTORE_KEYS = [
  'manufacturer_name',
  'manufacturer_address',
  'manufacturer_city',
  'manufacturer_postalcode',
  'manufacturer_state_province',
  'manufacturer_phone',
  'entity_country',
  'country_code',
  'email',
  'url',
];

/**
 * Nachweislich UNBRAUCHBARE EU-Verantwortliche. Nur diese werden geleert.
 *
 * GEMESSEN 2026-09-04: 315 Produkte tragen einen EU-Vertreter, obwohl ihr
 * Hersteller in der EU sitzt — 298 davon sind LIVE. Die allermeisten dieser
 * Einträge sind aber legitim (TZMO Deutschland GmbH für einen polnischen
 * Hersteller, Ferdinand Bilstein für „febi bilstein", Lidl Dienstleistung für
 * Lidl Stiftung). Sie pauschal zu leeren nähme ~300 laufenden Angeboten ein
 * rechtlich genutztes Feld weg — das verstößt gegen die goldene Regel.
 * Geleert wird deshalb nur, was BEWEISBAR falsch ist: die aus der
 * Registry-Verschmierung stammende Fremdfirma und Platzhaltertexte, die in
 * einem Rechtsfeld nichts verloren haben.
 */
const EU_REP_MUELL = [
  /^geaplan\s*gmbh$/i,
  /nicht\s+zweifelsfrei/i,
  /^(unbekannt|unknown|n\.?\s*a\.?|k\.?\s*a\.?|keine\s+angabe|entf(ä|ae)llt|tbd|todo|-+)$/i,
];

const EU_REP_KEYS = [
  'eu_responsible_name',
  'eu_responsible_address',
  'eu_responsible_city',
  'eu_responsible_postalcode',
  'eu_responsible_state_province',
  'eu_responsible_country',
  'eu_responsible_country_code',
  'eu_responsible_email',
  'eu_responsible_phone',
];

function s(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function parseArgs(argv) {
  const out = {
    apply: false, confirm: '', sku: '', outDir: '/tmp',
    registryOnly: false, produkteOnly: false, euRep: false, euRepAlle: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--apply') out.apply = true;
    else if (t === '--confirm') out.confirm = argv[++i] || '';
    else if (t === '--sku') out.sku = s(argv[++i]);
    else if (t === '--out') out.outDir = argv[++i] || '/tmp';
    else if (t === '--registry-only') out.registryOnly = true;
    else if (t === '--produkte-only') out.produkteOnly = true;
    else if (t === '--eu-rep-aufraeumen') out.euRep = true;
    else if (t === '--eu-rep-alle') { out.euRep = true; out.euRepAlle = true; }
  }
  return out;
}

function skuOf(p) {
  return s(p?.details?.identifiers?.sku || p?.identification?.sku || p?.sku);
}

/**
 * Gründe, die für sich allein eine Wiederherstellung rechtfertigen. `ort_getauscht`
 * gehört BEWUSST nicht dazu: ein anderer Ort beweist nicht, welcher der richtige
 * ist. Wo beide Stände gleich (un)stimmig sind, wird nichts angefasst — sonst
 * würde das Script raten, und genau das Raten hat den Schaden angerichtet.
 */
const HARTE_GRUENDE = new Set([
  'nachher_widerspruechlich',
  'eu_sitz_verloren',
  'herstellername_auf_marke_verkuerzt',
  'telefon_verloren',
]);

/** Hat der Enforce diesen Datensatz nachweislich VERSCHLECHTERT? */
function bewerteBackup(bak) {
  const before = bak?.before && typeof bak.before === 'object' ? bak.before : null;
  const after = bak?.after && typeof bak.after === 'object' ? bak.after : null;
  if (!before || !after) return null;

  const gruende = [];
  if (!isInternallyConsistentGpsr(after) && isInternallyConsistentGpsr(before)) {
    gruende.push('nachher_widerspruechlich');
  }
  const bLand = declaredCountryCode(before);
  const aLand = declaredCountryCode(after);
  if (bLand && aLand && EU_COUNTRY_CODES.has(bLand) && !EU_COUNTRY_CODES.has(aLand)) {
    gruende.push('eu_sitz_verloren');
  }
  const bName = s(before.manufacturer_name);
  const aName = s(after.manufacturer_name);
  if (bName && aName && bName.length > aName.length + 3 && bName.toLowerCase().includes(aName.toLowerCase())) {
    gruende.push('herstellername_auf_marke_verkuerzt');
  }
  const bOrt = s(before.manufacturer_city);
  const aOrt = s(after.manufacturer_city);
  if (bOrt && aOrt && bOrt.toLowerCase() !== aOrt.toLowerCase()) gruende.push('ort_getauscht');
  const bTel = s(before.manufacturer_phone);
  if (bTel && !s(after.manufacturer_phone)) gruende.push('telefon_verloren');

  if (!gruende.some((g) => HARTE_GRUENDE.has(g))) return null;
  // Der wiederherzustellende Stand muss selbst stimmig sein. Einen
  // widersprüchlichen Datensatz durch einen anderen widersprüchlichen zu
  // ersetzen ist keine Reparatur.
  if (!isInternallyConsistentGpsr(before)) return null;
  return gruende;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.apply && args.confirm !== CONFIRM_TOKEN) {
    throw new Error(`--apply braucht --confirm ${CONFIRM_TOKEN}`);
  }

  const firestore = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
  console.log('===================================================');
  console.log('GCP-Projekt :', process.env.GOOGLE_CLOUD_PROJECT);
  console.log('Tenant      :', TENANT);
  console.log('Modus       :', args.apply ? 'ANWENDEN (schreibt!)' : 'Trockenlauf (read-only)');
  if (args.sku) console.log('Nur SKU     :', args.sku);
  console.log('===================================================\n');

  const report = {
    projekt: process.env.GOOGLE_CLOUD_PROJECT,
    tenant: TENANT,
    apply: args.apply,
    sku: args.sku || null,
    registry: { geprueft: 0, widerspruechlich: [], entwertet: 0 },
    produkte: { geprueft: 0, wiederherstellbar: [], wiederhergestellt: 0, uebersprungen: [] },
    euRep: { kandidaten: [], bereinigt: 0 },
  };

  // ------------------------------------------------------------------
  // 1) Registry entwerten — ZUERST, sonst überschreibt sie die Produkte
  //    im selben Moment wieder.
  // ------------------------------------------------------------------
  const regSnap = await firestore.collection(REGISTRY).get();
  report.registry.geprueft = regSnap.size;

  let markenFilter = null;
  if (args.sku) {
    const psnap = await firestore.collection(PRODUCTS).where('details.identifiers.sku', '==', args.sku).limit(1).get();
    if (psnap.empty) throw new Error(`Produkt mit SKU ${args.sku} nicht gefunden`);
    const p = psnap.docs[0].data();
    markenFilter = new Set(
      [s(p?.identification?.brand), s(p?.details?.gpsr?.manufacturer_name)]
        .filter(Boolean)
        .map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, ''))
    );
  }

  if (!args.produkteOnly) {
    for (const doc of regSnap.docs) {
      const data = doc.data() || {};
      const gpsr = data.gpsr && typeof data.gpsr === 'object' ? data.gpsr : null;
      if (!gpsr) continue;
      if (markenFilter) {
        const key = doc.id.toLowerCase().replace(/[^a-z0-9]/g, '');
        const name = s(data.manufacturer_name).toLowerCase().replace(/[^a-z0-9]/g, '');
        const trifft = [...markenFilter].some((m) => key.startsWith(m) || m.startsWith(key) || name === m);
        if (!trifft) continue;
      }
      const probleme = findGpsrInconsistencies(gpsr);
      if (!probleme.length) continue;

      const bereitsEntwertet = Boolean(data.gpsr_chimaere_entwertet_v1);
      const eintrag = {
        key: doc.id,
        manufacturer_name: s(data.manufacturer_name),
        confidence: data.confidence ?? null,
        sources: Array.isArray(data.sources) ? data.sources.length : 0,
        probleme: probleme.map((p) => `${p.art}: ${p.details}`),
        bereitsEntwertet,
      };
      report.registry.widerspruechlich.push(eintrag);

      if (args.apply && !bereitsEntwertet) {
        // Entwerten statt löschen. Der Block wird nach
        // `gpsr_chimaere_entwertet_v1.vorher_gpsr` VERSCHOBEN — nichts geht
        // verloren, aber `gpsr` ist leer und damit für ALLE drei
        // Überlagerungs-Pfade unsichtbar (Enforce, Lese-Overlay UND der
        // ungeschützte Autofill). Das wirkt auch mit dem ALTEN, noch
        // ausgerollten Code: alle drei prüfen `Object.keys(regGpsr).length`.
        // `confidence: 0` + `sources: []` ist der zweite, unabhängige Riegel.
        await doc.ref.update({
          gpsr: {},
          confidence: 0,
          sources: [],
          gpsr_chimaere_entwertet_v1: {
            at_iso: new Date().toISOString(),
            probleme: eintrag.probleme,
            vorher_confidence: data.confidence ?? null,
            vorher_sources: Array.isArray(data.sources) ? data.sources : [],
            vorher_gpsr: gpsr,
          },
        });
        report.registry.entwertet += 1;
      }
    }
  }

  // ------------------------------------------------------------------
  // 2) Produkte aus ihrem eigenen Backup wiederherstellen
  // ------------------------------------------------------------------
  if (!args.registryOnly) {
    const prodSnap = args.sku
      ? await firestore.collection(PRODUCTS).where('details.identifiers.sku', '==', args.sku).get()
      : await firestore.collection(PRODUCTS).get();
    report.produkte.geprueft = prodSnap.size;

    for (const doc of prodSnap.docs) {
      const p = doc.data() || {};
      const gpsr = p?.details?.gpsr && typeof p.details.gpsr === 'object' ? p.details.gpsr : {};
      const bak = p?.ops?.data_quality?.gpsr_backup_v1;
      const gruende = bewerteBackup(bak);
      // Der EU-Vertreter-Schritt muss den Stand NACH der Wiederherstellung
      // bewerten: solange das Sitzland noch fälschlich "China" ist, sähe er
      // einen Nicht-EU-Hersteller und würde den fremden EU-Vertreter behalten.
      let gpsrNachher = { ...gpsr };

      // --- 2a) Wiederherstellung aus dem Backup ---
      if (gruende) {
        const before = bak.before;
        const after = bak.after;
        // Hat seither ein MENSCH korrigiert? Dann gewinnt er. Ein Mensch
        // erkennt man an einem DRITTEN Wert: einem, der weder aus dem Backup
        // (`before`) noch vom Enforce (`after`) stammt. Ein Feld, das heute
        // leer ist, obwohl `after` es führte, ist dagegen KEINE Korrektur —
        // das ist die vom EU-Rep-Hook gelöschte Telefonnummer.
        const menschlicheAenderungen = RESTORE_KEYS.filter((k) => {
          const heute = s(gpsr[k]);
          if (!heute) return false;
          return heute !== s(after[k]) && heute !== s(before[k]);
        });
        const nochKaputt = menschlicheAenderungen.length === 0;
        const updates = {};
        for (const k of RESTORE_KEYS) {
          const vorher = s(before[k]);
          const heute = s(gpsr[k]);
          if (vorher && vorher !== heute) updates[`details.gpsr.${k}`] = before[k];
        }
        const eintrag = {
          id: doc.id,
          sku: skuOf(p),
          marke: s(p?.identification?.brand),
          gruende,
          registry_key: bak.registry_key || null,
          registry_confidence: bak.registry_confidence ?? null,
          von: `${s(after.manufacturer_name)} / ${s(after.manufacturer_city)} / ${declaredCountryCode(after)}`,
          nach: `${s(before.manufacturer_name)} / ${s(before.manufacturer_city)} / ${declaredCountryCode(before)}`,
          felder: Object.keys(updates).map((k) => k.replace('details.gpsr.', '')),
          nochKaputt,
          menschlicheAenderungen,
        };
        if (!Object.keys(updates).length) {
          report.produkte.uebersprungen.push({ ...eintrag, grund: 'nichts_zu_tun' });
        } else if (!nochKaputt) {
          report.produkte.uebersprungen.push({ ...eintrag, grund: 'seither_geaendert_mensch_gewinnt' });
        } else {
          report.produkte.wiederherstellbar.push(eintrag);
          for (const [pfad, wert] of Object.entries(updates)) {
            gpsrNachher[pfad.replace('details.gpsr.', '')] = wert;
          }
          if (args.apply) {
            updates['ops.data_quality.gpsr_chimaere_repair_v1'] = {
              at_iso: new Date().toISOString(),
              quelle: 'gpsr_backup_v1.before',
              gruende,
              registry_key: bak.registry_key || null,
            };
            await doc.ref.update(updates);
            report.produkte.wiederhergestellt += 1;
          }
        }
      }

      // --- 2b) EU-Verantwortlicher bei EU-Hersteller (opt-in) ---
      if (args.euRep) {
        const gpsrJetzt = gpsrNachher;
        const land = declaredCountryCode(gpsrJetzt);
        const repName = s(gpsrJetzt.eu_responsible_name);
        const hatEuRep = EU_REP_KEYS.some((k) => s(gpsrJetzt[k]));
        // Nur nachweislich unbrauchbare Vertreter anfassen (siehe EU_REP_MUELL),
        // es sei denn, der Betreiber verlangt ausdrücklich alle.
        const istMuell = args.euRepAlle || EU_REP_MUELL.some((re) => re.test(repName));
        if (land && EU_COUNTRY_CODES.has(land) && hatEuRep && istMuell) {
          const eintrag = {
            id: doc.id,
            sku: skuOf(p),
            marke: s(p?.identification?.brand),
            hersteller_land: land,
            eu_rep: s(gpsrJetzt.eu_responsible_name),
          };
          report.euRep.kandidaten.push(eintrag);
          if (args.apply) {
            // ACHTUNG: `saveProductV2` ist ein MERGE — ein `delete` am
            // In-Memory-Objekt käme nie in Firestore an. Map-Schlüssel lassen
            // sich nur über einen gezielten update() mit FieldValue.delete()
            // entfernen (gleiche Begründung wie in
            // repair-placeholder-brand-gpsr.js).
            const updates = {};
            for (const k of EU_REP_KEYS) {
              if (s(gpsrJetzt[k])) updates[`details.gpsr.${k}`] = FieldValue.delete();
            }
            updates['ops.data_quality.gpsr_eu_rep_cleanup_v1'] = {
              at_iso: new Date().toISOString(),
              grund: `Hersteller sitzt in ${land} (EU) — ein EU-Verantwortlicher ist nicht erforderlich`,
              entfernt: Object.keys(updates).map((k) => k.replace('details.gpsr.', '')),
              vorher_name: s(gpsrJetzt.eu_responsible_name),
            };
            await doc.ref.update(updates);
            report.euRep.bereinigt += 1;
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  console.log('--- REGISTRY ---');
  console.log('geprüft                 :', report.registry.geprueft);
  console.log('widersprüchlich         :', report.registry.widerspruechlich.length);
  console.log('davon schon entwertet   :', report.registry.widerspruechlich.filter((e) => e.bereitsEntwertet).length);
  console.log('entwertet (dieser Lauf) :', report.registry.entwertet);
  for (const e of report.registry.widerspruechlich.slice(0, 20)) {
    console.log(`  ${e.key} (conf ${e.confidence}, ${e.sources} Quellen) — ${e.probleme.join(' | ')}`);
  }
  if (report.registry.widerspruechlich.length > 20) {
    console.log(`  … und ${report.registry.widerspruechlich.length - 20} weitere (siehe Bericht)`);
  }

  console.log('\n--- PRODUKTE ---');
  console.log('geprüft                 :', report.produkte.geprueft);
  console.log('wiederherstellbar       :', report.produkte.wiederherstellbar.length);
  console.log('übersprungen            :', report.produkte.uebersprungen.length);
  console.log('wiederhergestellt       :', report.produkte.wiederhergestellt);
  for (const e of report.produkte.wiederherstellbar.slice(0, 20)) {
    console.log(`  ${e.sku} [${e.marke}] ${e.von}  ->  ${e.nach}   (${e.gruende.join(', ')})`);
  }
  if (report.produkte.wiederherstellbar.length > 20) {
    console.log(`  … und ${report.produkte.wiederherstellbar.length - 20} weitere (siehe Bericht)`);
  }

  if (args.euRep) {
    console.log('\n--- EU-VERANTWORTLICHER BEI EU-HERSTELLER ---');
    console.log('Kandidaten              :', report.euRep.kandidaten.length);
    console.log('bereinigt               :', report.euRep.bereinigt);
    for (const e of report.euRep.kandidaten.slice(0, 15)) {
      console.log(`  ${e.sku} [${e.marke}] Hersteller in ${e.hersteller_land}, EU-Vertreter "${e.eu_rep}"`);
    }
  }

  const outPath = path.join(args.outDir, `repair-gpsr-chimaere-${args.apply ? 'apply' : 'dryrun'}.json`);
  fsNode.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('\nBericht:', outPath);
  if (!args.apply) {
    console.log(`\nZum Anwenden:  node backend/scripts/repair-gpsr-chimaere.js --apply --confirm ${CONFIRM_TOKEN}`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('FEHLER:', e && e.stack ? e.stack : e);
  process.exit(1);
});
