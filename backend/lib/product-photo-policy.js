'use strict';

// Betreiberreferenz 18.09.2026: bessere Fotografie, kein restaurierter Artikel.
const PROFESSIONAL_RELIGHTING = [
  'PROFESSIONAL PRODUCT RELIGHTING IS ALLOWED AND ENCOURAGED.',
  'Correct exposure and white balance, neutralize lighting color casts, lift recoverable shadows,',
  'control distracting highlights and use soft studio illumination, subtle fill and restrained edge light.',
  'Use physically plausible, material-dependent reflections; improve clarity without inventing texture.',
  'The item may look much better photographed, but not newer, cleaner, less damaged or more expensive.',
].join(' ');

const PRODUCT_PRESERVATION = [
  'Do not cosmetically alter, restore, idealize, repair, or misrepresent the product.',
  'Preserve its exact identity and variant, geometry, proportions, true color, material, matte or glossy finish,',
  'texture, logos, physical text, model markings, ports, buttons, seams, quantity and included components.',
  'Preserve scratches, dents, scuffs, discoloration, wear, condition-relevant dust or residue, package damage, tape and seals.',
  'Do not remove defects through lighting or conceal them in shadow. Do not turn matte material glossy or plastic into metal.',
  'Reveal only details supported by reference images. Do not reconstruct fully black, clipped, blurred, hidden or unphotographed areas.',
  'Keep unreadable markings unreadable instead of inventing text. Never invent missing parts or repair packaging.',
].join(' ');

const RELIGHTING_REVIEW = [
  'Licht, Belichtung, Weissabgleich, plausible Reflexionen, Hintergrund und Kontaktschatten duerfen sich deutlich verbessern.',
  'Bewerte reine Helligkeitsunterschiede NICHT als Produktabweichung. Unterscheide Lichtfarbstich von echter Vergilbung.',
  'Pruefe condition_kept: Kratzer, Dellen, Flecken, Abrieb, Vergilbung, Verpackungsschaeden, Klebeband und Siegel erhalten und nicht durch Licht versteckt?',
  'Pruefe material_kept: echtes Material, Struktur und matt/glaenzend erhalten?',
  'Pruefe color_kept: tatsaechliche Produktfarbe erhalten, trotz korrigiertem Licht?',
  'Pruefe evidence_kept: keine erfundenen Details in schwarzen, ausgebrannten, unscharfen, verdeckten oder nicht fotografierten Bereichen?',
  'Unlesbare Schrift darf unlesbar bleiben; erfundene lesbare Schrift ist ein Fehler. Eine erkennbare Restaurierung ist ein Fehler, auch beim gleichen Modell.',
].join('\n');

module.exports = { PROFESSIONAL_RELIGHTING, PRODUCT_PRESERVATION, RELIGHTING_REVIEW };
