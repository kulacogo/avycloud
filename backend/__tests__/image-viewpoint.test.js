/**
 * Tests für lib/image-viewpoint.js — Beleg-Bilanz für Produktansichten.
 *
 * Die zentrale Zusicherung: eine Ansicht, für die es KEIN echtes Foto gibt,
 * darf NIE in den Erzeugungsplan geraten. Genau das war die Ursache der
 * Beschwerde "Varianten sind nicht originalgetreu" — der alte Pfad verlangte
 * pauschal eine Rückansicht und schickte dazu ein Frontfoto.
 */

const {
  summarizeEvidence,
  planFaithfulVariants,
  VIEWPOINT_LABELS_DE,
} = require('../lib/image-viewpoint');

function view(index, viewpoint, extra = {}) {
  return {
    index,
    viewpoint,
    showsProduct: true,
    fullyVisible: true,
    usableAsReference: true,
    confidence: 0.9,
    note: '',
    ...extra,
  };
}

beforeEach(() => {
  delete process.env.VIEWPOINT_MIN_CONFIDENCE;
});

describe('summarizeEvidence', () => {
  it('meldet nur Ansichten mit ausreichender Sicherheit als belegt', () => {
    const e = summarizeEvidence({
      views: [view(0, 'front'), view(1, 'back', { confidence: 0.2 })],
    });
    expect(e.belegt).toEqual(['front']);
  });

  it('zaehlt Verpackungs- und unklare Bilder NICHT als Produktansicht', () => {
    const e = summarizeEvidence({
      views: [view(0, 'packaging'), view(1, 'unclear'), view(2, 'front')],
    });
    expect(e.belegt).toEqual(['front']);
  });

  it('ignoriert Bilder, die das Produkt gar nicht zeigen', () => {
    const e = summarizeEvidence({ views: [view(0, 'front', { showsProduct: false })] });
    expect(e.belegt).toEqual([]);
  });

  it('sortiert innerhalb einer Ansicht das beste Foto nach vorn', () => {
    const e = summarizeEvidence({
      views: [
        view(0, 'front', { confidence: 0.7, fullyVisible: false }),
        view(1, 'front', { confidence: 0.95, fullyVisible: true }),
      ],
    });
    expect(e.byViewpoint.front[0].index).toBe(1);
  });

  it('liefert leere Bilanz ohne Klassifikation', () => {
    expect(summarizeEvidence(null).belegt).toEqual([]);
    expect(summarizeEvidence({ views: [] }).belegt).toEqual([]);
  });

  it('sammelt brauchbare Referenzen auch unterhalb der Sicherheitsschwelle', () => {
    // Als IDENTITAETSANKER taugt ein Foto auch dann, wenn seine Seiten-Zuordnung
    // unsicher ist — es zeigt trotzdem den richtigen Artikel.
    const e = summarizeEvidence({ views: [view(0, 'unclear', { confidence: 0.1 })] });
    expect(e.referenceIndexes).toEqual([0]);
    expect(e.belegt).toEqual([]);
  });
});

describe('planFaithfulVariants — erfindet NICHTS', () => {
  it('plant keine Rueckansicht, wenn nur ein Frontfoto vorliegt', () => {
    const e = summarizeEvidence({ views: [view(0, 'front')] });
    const { plan, skipped } = planFaithfulVariants(e);

    expect(plan.map((p) => p.viewpoint)).toEqual(['front']);
    const back = skipped.find((s) => s.viewpoint === 'back');
    expect(back).toBeTruthy();
    expect(back.reason).toBe('kein_foto');
    expect(back.label).toBe(VIEWPOINT_LABELS_DE.back);
  });

  it('plant genau die Ansichten, die fotografiert wurden', () => {
    const e = summarizeEvidence({ views: [view(0, 'front'), view(1, 'back'), view(2, 'label')] });
    const { plan } = planFaithfulVariants(e);
    expect(plan.map((p) => p.viewpoint).sort()).toEqual(['back', 'front', 'label']);
  });

  it('setzt das Hauptbild an die erste Stelle', () => {
    const e = summarizeEvidence({ views: [view(0, 'back'), view(1, 'front')] });
    const { plan } = planFaithfulVariants(e);
    expect(plan[0].viewpoint).toBe('front');
  });

  it('verweist jede geplante Ansicht auf ihr echtes Quellfoto', () => {
    const e = summarizeEvidence({ views: [view(3, 'front'), view(7, 'back')] });
    const { plan } = planFaithfulVariants(e);
    expect(plan.find((p) => p.viewpoint === 'front').sourceIndex).toBe(3);
    expect(plan.find((p) => p.viewpoint === 'back').sourceIndex).toBe(7);
  });

  it('haelt das Kontingent ein und meldet den Ueberhang statt ihn zu verschweigen', () => {
    const e = summarizeEvidence({
      views: [view(0, 'front'), view(1, 'side'), view(2, 'back'), view(3, 'top'), view(4, 'detail')],
    });
    const { plan, skipped } = planFaithfulVariants(e, { maxVariants: 2 });
    expect(plan).toHaveLength(2);
    expect(skipped.some((s) => s.reason === 'kontingent_erschoepft')).toBe(true);
  });

  it('plant GAR NICHTS ohne jeden Beleg', () => {
    const { plan, skipped } = planFaithfulVariants(summarizeEvidence(null));
    expect(plan).toHaveLength(0);
    expect(skipped.every((s) => s.reason === 'kein_foto')).toBe(true);
  });

  it('vergibt je Ansicht einen eindeutigen Variantennamen', () => {
    const e = summarizeEvidence({ views: [view(0, 'front'), view(1, 'back')] });
    const { plan } = planFaithfulVariants(e);
    const namen = plan.map((p) => p.variant);
    expect(new Set(namen).size).toBe(namen.length);
    expect(namen).toContain('studio_front');
  });
});

describe('eine Vorlage speist nur EINE Ansicht', () => {
  it('vergibt dasselbe Quellfoto nie an zwei Ansichten', () => {
    // Sonst entstuenden zwei identische Bilder mit VERSCHIEDENEN Etiketten —
    // dasselbe Foto zugleich als Vorder- und als Rueckansicht.
    const e = summarizeEvidence({ views: [view(0, 'front'), view(0, 'back')] });
    const { plan } = planFaithfulVariants(e);
    const quellen = plan.map((p) => p.sourceIndex);
    expect(new Set(quellen).size).toBe(quellen.length);
    expect(plan).toHaveLength(1);
  });

  it('weicht auf das naechstbeste Foto derselben Ansicht aus', () => {
    const e = summarizeEvidence({ views: [view(0, 'front'), view(1, 'front'), view(0, 'back')] });
    const { plan } = planFaithfulVariants(e);
    const quellen = plan.map((p) => p.sourceIndex);
    expect(new Set(quellen).size).toBe(quellen.length);
  });

  it('unbrauchbare Fotos werden weder Vorlage noch Anker', () => {
    const e = summarizeEvidence({ views: [view(0, 'front', { usableAsReference: false })] });
    expect(e.belegt).toEqual([]);
    expect(e.referenceIndexes).toEqual([]);
  });

  it('mahnt nur Vorder-, Seiten- und Rueckansicht an, nicht alle sieben', () => {
    const { skipped } = planFaithfulVariants(summarizeEvidence({ views: [view(0, 'front')] }));
    expect(skipped.map((s) => s.viewpoint).sort()).toEqual(['back', 'side']);
  });

  it('maxVariants 0 liefert wirklich nichts', () => {
    const e = summarizeEvidence({ views: [view(0, 'front')] });
    expect(planFaithfulVariants(e, { maxVariants: 0 }).plan).toHaveLength(0);
  });
});

describe('ein Bild je echtem Foto, bis zum Kontingent', () => {
  it('nutzt ALLE brauchbaren Fotos, auch wenn sie dieselbe Seite zeigen', () => {
    // Der gemeldete Fall: fuenf echte Fotos, alle als Vorderansicht erkannt.
    // Vorher gab es dafuer EIN Bild, vier Fotos blieben ungenutzt.
    const views = [0, 1, 2, 3, 4].map((i) => view(i, 'front', { confidence: 0.95 - i * 0.05 }));
    const { plan } = planFaithfulVariants(summarizeEvidence({ views }));
    expect(plan).toHaveLength(4);
    expect(new Set(plan.map((p) => p.sourceIndex)).size).toBe(4);
  });

  it('vergibt fuer Mehrfach-Ansichten eindeutige Variantennamen und lesbare Etiketten', () => {
    const views = [view(0, 'front'), view(1, 'front'), view(2, 'front')];
    const { plan } = planFaithfulVariants(summarizeEvidence({ views }));
    expect(plan.map((p) => p.variant)).toEqual(['studio_front', 'studio_front_2', 'studio_front_3']);
    expect(plan.map((p) => p.label)).toEqual(['Vorderansicht', 'Vorderansicht (2)', 'Vorderansicht (3)']);
  });

  it('nimmt VIELFALT zuerst — erst je Ansicht eine, dann auffuellen', () => {
    const views = [
      view(0, 'front', { confidence: 0.95 }),
      view(1, 'front', { confidence: 0.9 }),
      view(2, 'front', { confidence: 0.85 }),
      view(3, 'side'),
      view(4, 'back'),
    ];
    const { plan } = planFaithfulVariants(summarizeEvidence({ views }));
    // Seite und Rueckseite duerfen NICHT von einem dritten Frontfoto verdraengt werden.
    expect(plan.map((p) => p.viewpoint)).toEqual(['front', 'side', 'back', 'front']);
  });

  it('fuellt die Vier NICHT mit erfundenen Ansichten auf', () => {
    const { plan } = planFaithfulVariants(summarizeEvidence({ views: [view(0, 'front'), view(1, 'side')] }));
    expect(plan).toHaveLength(2);
  });

  it('meldet ungenutzte Fotos gebuendelt statt sie zu verschweigen', () => {
    const views = [0, 1, 2, 3, 4, 5].map((i) => view(i, 'front'));
    const { skipped } = planFaithfulVariants(summarizeEvidence({ views }));
    const rest = skipped.find((s) => s.reason === 'kontingent_erschoepft');
    expect(rest).toBeTruthy();
    expect(rest.label).toContain('2');
  });

  it('respektiert ein groesseres Kontingent', () => {
    const views = [0, 1, 2, 3, 4, 5].map((i) => view(i, 'front'));
    expect(planFaithfulVariants(summarizeEvidence({ views }), { maxVariants: 6 }).plan).toHaveLength(6);
  });
});

describe('Sicherheitsschwelle', () => {
  it('laesst sich per ENV strenger stellen', () => {
    process.env.VIEWPOINT_MIN_CONFIDENCE = '0.95';
    const e = summarizeEvidence({ views: [view(0, 'front', { confidence: 0.9 })] });
    expect(e.belegt).toEqual([]);
  });

  it('faellt bei unbrauchbarem ENV-Wert auf den Default zurueck', () => {
    process.env.VIEWPOINT_MIN_CONFIDENCE = 'quatsch';
    const e = summarizeEvidence({ views: [view(0, 'front', { confidence: 0.7 })] });
    expect(e.belegt).toEqual(['front']);
  });
});
