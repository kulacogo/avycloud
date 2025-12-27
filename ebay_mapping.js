// ==UserScript==
// @name         Baselinker CSV → eBay Kategorien (FINAL WORKING)
// @match        https://panel-f.baselinker.com/ebay_link_values_to_categories.php*
// @grant        none
// ==/UserScript==

(async function () {
  'use strict';

  /* ========= 1. CSV-MAPPING (Auszug – erweiterbar) =========
     Format: "Baselinker Kategoriename" : "eBay Kategorie-ID"
     Quelle: ebayde_kategorien.csv
  */
  const MAP = {
    "Accessoires": "4250",
    "Akku-Hartbodenreiniger": "184381",
    "Akku-Staubsauger": "20617",
    "Autoabdeckung": "180136",
    "Autoabdeckung / Hagelschutzplane": "180136",
    "Baby": "2984",
    "Bad & Küche": "20625"
    // 👉 HIER ALLE WEITEREN ZEILEN AUS DEM CSV ERGÄNZEN
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ========= 2. Alle Kategorie-Zeilen finden ========= */
  const rows = [...document.querySelectorAll("div")]
    .filter(d => /\(id:\s*\d+\)/.test(d.innerText));

  let done = 0;
  let skipped = 0;

  for (const row of rows) {
    const nameMatch = row.innerText.match(/^(.+?)\s*\(id:/);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim();
    const ebayId = MAP[name];

    if (!ebayId) {
      skipped++;
      continue;
    }

    /* ========= 3. Kategorie anklicken (öffnet Dialog) ========= */
    row.click();
    await sleep(700);

    const dialog = document.querySelector("[role='dialog']");
    if (!dialog) {
      skipped++;
      continue;
    }

    /* ========= 4. „Nummer angegeben“ wählen ========= */
    const select = dialog.querySelector("select");
    const opt = [...select.options].find(o => o.text.includes("Nummer angegeben"));
    if (!opt) {
      skipped++;
      dialog.querySelector("button")?.click();
      continue;
    }

    select.value = opt.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(300);

    /* ========= 5. eBay-Kategorie-ID eintragen ========= */
    const input = dialog.querySelector("input[type='text']");
    input.value = ebayId;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(300);

    /* ========= 6. SCHLIESSEN klicken (WICHTIG!) ========= */
    const closeBtn = [...dialog.querySelectorAll("button")]
      .find(b => b.innerText.trim() === "SCHLIESSEN");

    closeBtn.click();
    await sleep(900);

    console.log("✔ gesetzt:", name, ebayId);
    done++;
  }

  alert(`FERTIG\nGesetzt: ${done}\nÜbersprungen (kein Mapping): ${skipped}`);
})();