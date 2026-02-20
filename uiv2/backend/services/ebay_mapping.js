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
    "Antennen": "169368",
    "Aufbewahrung": "40719",
    "Ausrüstung": "21566",
    "Auto & Motorrad": "62844",
    "Auto & Motorrad: Teile": "131090",
    "Autoabdeckung": "180136",
    "Autoabdeckung / Hagelschutzplane": "180136",
    "Automaten": "8727",
    "Bad & Küche": "20625",
    "Badewannen": "30251",
    "Badschrank": "260625",
    "Badzubehör & -textilien": "259327",
    "Basteln & Kreativität": "120",
    "Beauty & Gesundheit": "26395",
    "Beistelltisch / Side Table": "38204",
    "Bekleidung": "8697",
    "Bettdecken": "66728",
    "Bettlaken": "20460",
    "Bettwaren, -wäsche & Matratzen": "20444",
    "Bettwäsche": "37644",
    "Bit-Sätze": "83594",
    "Boardwerkzeugsets & -taschen": "25644",
    "Bogenschießen": "20835",
    "Bremsbeläge": "57357",
    "Bücher": "8677",
    "Bücher & Zeitschriften": "267",
    "Büro & Schreibwaren": "9815",
    "Bürostuhl": "68464",
    "Business & Industrie": "12576",
    "Camping & Outdoor": "16034",
    "Campingliege": "87099",
    "Computer, Tablets & Netzwerk": "58058",
    "Damenschuhe": "3034",
    "Dekoration": "10033",
    "Drucker": "1245",
    "Duschregal / Über-Tür-Duschablage": "117029",
    "Dutch Oven / Feuertopf": "98844",
    "E-Scooter": "60069",
    "Elektrik & Zündung": "179853",
    "Elektrische Ventilatoren": "4037",
    "Elektro-Roller": "9939",
    "Elektromotorrad- & Elektrorollerteile & -zubehör": "263193",
    "Elektronik": "8012",
    "Elektronik & Computer": "8012",
    "Elektroroller-Zubehör": "4702",
    "Elektrowerkzeuge": "3247",
    "Entsafter & Saftpressen": "260150",
    "Fahrrad": "420",
    "Fahrradanhänger": "85040",
    "Fahrradpumpen": "420",
    "Fahrradsattel": "420",
    "Fahrradsättel": "420",
    "Fahrradschlösser": "167065",
    "Fahrradtasche / Oberrohrtasche": "420",
    "Fahrradteile & -komponenten": "57262",
    "Fahrradwerkzeug": "420",
    "Fahrradzubehör": "177832",
    "Fanartikel": "2024",
    "Farbstifte & Zeichenkohle": "28108",
    "Fensterfolie / Energiesparfolie": "21614",
    "Fensterfolien": "175757",
    "Filzstifte": "127504",
    "Fitness & Training": "110717",
    "Fitness- & Laufschuhe": "158916",
    "Flaschen": "34748",
    "Fliesen": "262406",
    "Flüssigreiniger": "30526",
    "Freizeit": "28829",
    "Freizeithemden": "57990",
    "Füllfederhalter": "13999",
    "Füllhalter & Schreibgeräte": "19345",
    "Garten & Pool": "159912",
    "Garten & Terrasse": "159912",
    "Gartenbank": "260928",
    "Gartengeräte": "39079",
    "Gartenmöbel": "39080",
    "Gastronomie-Kochgeschirr & Zubehör": "25357",
    "Gastronomie-Kochgeschirr- & zubehör": "25357",
    "Geldbörsen & Etuis": "2996",
    "Geldspielautomaten": "3948",
    "Geschirr & Besteck": "59212",
    "Geschirr & Gläser": "258474",
    "Gesichtspflegegeräte": "177767",
    "Getriebe": "263428",
    "Gewichthebergürtel": "36155",
    "Gläser": "34749",
    "Golfschuhe": "181136",
    "Grillzubehör": "260931",
    "Haarpflege": "115329",
    "Hagelschutzplane": "180136",
    "Hallenleuchte": "26219",
    "Halter": "47089",
    "Handschuhe": "14075",
    "Handschuhe & Fäustlinge": "2994",
    "Handtuchhalter": "20442",
    "Handtuchhalter / Handtuchhalter für Tür / Dusche": "20442",
    "Handwerkzeuge": "3244",
    "Haushalt & Küche": "8759",
    "Haushaltsartikel": "1152",
    "Haushaltsgeräte": "20710",
    "Hausschuhe": "11505",
    "Haustierbedarf": "1281",
    "Heimwerker": "3187",
    "Heißluftfritteuse": "260165",
    "Heißluftfritteuse / Air Fryer": "183124",
    "Heißluftfritteusen": "185033",
    "Heizlüfter / Keramikheizlüfter": "20613",
    "Herren Rasierklingen": "47931",
    "Herzfrequenzmesser": "15277",
    "Hoodie": "5084",
    "Kabel": "47075",
    "Kaffeevollautomaten": "65643",
    "Karaffen & Dekanter": "258510",
    "Karten": "84900",
    "Kartenleser für Automaten und Zahlungsterminals": "8727",
    "Kartenspiele": "13518",
    "Kinder": "49177",
    "Kinder- & Jugendliteratur": "60033",
    "Kinderbesteck": "117385",
    "Kinderbuch": "49177",
    "Kinderroller": "49177",
    "Kinderroller / Tretroller": "49177",
    "Kinderschuhe & -boots": "21240",
    "Kindersitze": "185029",
    "Kissen": "52346",
    "Klimaanlagen & Heizgeräte": "69197",
    "Klimageräte": "183960",
    "Klimaleitungen, -schläuche & Anschlüsse": "33544",
    "Kochen & Backen": "259329",
    "Kochen & Genießen": "20625",
    "Kochgeschirr": "87141",
    "Konsolen": "32525",
    "Kopfhörer": "26505",
    "Kopfkissen": "180907",
    "Küche": "177073",
    "Küchen-, Grillzubehör / Wok / Gusseisenpfanne": "260931",
    "Küchenarmaturen": "29508",
    "Küchengeräte": "53220",
    "Küchenhelfer": "20635",
    "Küchenmesser": "177005",
    "künstliche Bäume": "550",
    "Laufgitter": "2988",
    "Laufschuhe": "158916",
    "LED High Bay / Hallenleuchte": "178019",
    "LED Strahler": "181886",
    "Liegen": "79684",
    "Luft- & Kraftstoffversorgung": "33549",
    "Luftentfeuchter / Feuchtigkeitsabsorber": "79621",
    "Mainboards": "1244",
    "Malen & Zeichnen": "84904",
    "Matratzenschoner & Auflagen": "162041",
    "Medizinische Geräte": "30807",
    "Mikrofone": "19656",
    "Milbensauger / Matratzenstaubsauger": "20614",
    "Möbel & Wohnen": "11700",
    "Motoren & Motorenteile": "33612",
    "Nass-Trocken-Sauger": "63864",
    "Nass-Trockensauger": "66961",
    "Nockenwellen": "33614",
    "Nudelmaschinen": "20680",
    "Ofenrohr / Rauchrohr": "84184",
    "Pastell": "28107",
    "Pendel": "39216",
    "Pflanzsubstrat / Spezial-Substrat für Palmen": "151",
    "Pflege": "15456",
    "Poolzubehör": "4702",
    "Pro-Audio Equipment": "180014",
    "Pumpensteuerungen": "184059",
    "Radsport": "7294",
    "Regale & Aufbewahrung": "3199",
    "Regenschirme": "46036",
    "Reifenreparatur": "179466",
    "Reinigungshandschuhe": "259347",
    "Roboter": "2662",
    "Roller": "9939",
    "Rollos & Jalousien": "20585",
    "Rucksack": "16081",
    "Rucksack / Rolltop": "181379",
    "Rucksäcke & Taschen": "37412",
    "Sachbuch": "60034",
    "Sägekettenöl": "131252",
    "Salz- & Pfeffermühlen": "257980",
    "Sammelkartenspiele / TCG": "2536",
    "Sandalen": "11504",
    "Sattelregenschutz / Sattelbezug": "47281",
    "Satteltasche / Fahrrad-Zubehör": "420",
    "Saugroboter": "2662",
    "Schalen": "58857",
    "Schalter": "181845",
    "Schlaginstrumente": "37976",
    "Schläuche": "177829",
    "Schläuche & Verrohrung": "177829",
    "Schlitten": "59892",
    "Schlitten & Bobs": "59892",
    "Schlösser": "167065",
    "Schraubenschlüssel": "20770",
    "Schreibwaren": "261065",
    "Schubladenschienen": "134642",
    "Schuhe": "13523",
    "Schulbedarf": "62559",
    "Schutzkleidung": "177795",
    "Sensoren": "181784",
    "Servierwagen": "138995",
    "Sichtschutz & Rollos": "20585",
    "Sitzauflagen": "180916",
    "Sitzmöbel": "62492",
    "Sneaker": "15709",
    "Solid State Drives (SSD)": "175669",
    "Sonnenbrillen": "45246",
    "Sonnenschirmzubehör": "261011",
    "Spannbettlaken": "20460",
    "Spannbetttuch / Bettwäsche": "37644",
    "Sport & Fitness": "74475",
    "Sport & Freizeit": "74156",
    "Sportschuhe": "888",
    "Stand Up Paddle (SUP)": "36409",
    "Stand- & Tischventilatoren": "20612",
    "Standmixer": "133704",
    "Standventilator": "20612",
    "Staubsauger": "20614",
    "Steckdosenleiste / Verlängerungskabel": "259493",
    "Steckschlüssel": "84237",
    "Stehleuchten": "62471",
    "Stiefel": "11498",
    "Strandmuscheln": "179011",
    "Stühle": "54235",
    "Sweatshirts & Kapuzenpullover": "59325",
    "Tablet-Bodenständer": "182144",
    "Tassen & Becher": "62864",
    "Tastaturen, Mäuse & Pointing": "3676",
    "Teile": "78533",
    "Teleskopschiene / Schubladenschiene": "134642",
    "Textil": "8021",
    "Textil / Bettwaren": "8021",
    "Tinte, Toner & Papier": "11195",
    "Tintenpatronen": "16191",
    "Tischdekoration": "52347",
    "Toner": "62510",
    "Töpfe & Pfannen": "974",
    "Topfset / Kochgeschirr": "87141",
    "Trampoline": "167526",
    "Treppen": "19341",
    "Trinkflaschen": "158950",
    "Trinkwassersprudler": "25845",
    "Ventilator / Windmaschine": "185114",
    "Ventilatoren": "185114",
    "Verstärker": "21647",
    "Wanderschuhe": "181391",
    "Waschbecken": "71283",
    "Wäscheständer": "20622",
    "Waschmaschinen- & Trocknerteile": "99697",
    "Wasserfilter-Kartuschen": "54145",
    "Weihnachtsdeko": "166725",
    "Werkzeug": "153944",
    "Werkzeug & Garten": "153944",
    "Werkzeuge": "631",
    "Werkzeuge & Tools": "515",
    "Werkzeugkoffer": "33089",
    "Werkzeugkoffer & Boxen": "33089",
    "Wintersport": "35495",
    "Yoga & Pilates": "158927",
    "Yogamatte / Trainingsmatte": "158928",
    "Yogamatten": "158928",
    "Zahlungssysteme & POS-Hardware": "179975",
    "Zelt- & Strandmuschelzubehör": "36120",
    "Zubehör": "4702"
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function runMapping() {
    console.log("▶️ Mapping gestartet");

    // WICHTIG: erst warten bis Kategorien da sind
    await sleep(2000);

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

      row.click();
      await sleep(800);

      const dialog = [...document.querySelectorAll("[role='dialog']")]
        .find(d => d.offsetParent !== null);
      if (!dialog) {
        skipped++;
        continue;
      }

      const select = dialog.querySelector("select");
      const opt = [...select.options].find(o => o.text.includes("Nummer angegeben"));
      if (!opt) {
        skipped++;
        continue;
      }

      select.value = opt.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(300);

      const input = dialog.querySelector("input[type='text']");
      input.value = ebayId;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(300);

      const closeBtn = [...dialog.querySelectorAll("button")]
        .find(b => /schließ/i.test(b.innerText));
      closeBtn?.click();

      await sleep(700);

      console.log("✔ gesetzt:", name, ebayId);
      done++;
    }

    alert(`FERTIG\nGesetzt: ${done}\nÜbersprungen: ${skipped}`);
  }

  // 🔵 START-BUTTON
  const btn = document.createElement("button");
  btn.innerText = "▶ eBay Kategorien automatisch setzen";
  btn.style.position = "fixed";
  btn.style.bottom = "20px";
  btn.style.right = "20px";
  btn.style.zIndex = "9999";
  btn.style.padding = "10px 14px";
  btn.style.background = "#1a73e8";
  btn.style.color = "#fff";
  btn.style.borderRadius = "6px";
  btn.style.border = "none";
  btn.style.cursor = "pointer";
  btn.onclick = runMapping;

  document.body.appendChild(btn);

})();