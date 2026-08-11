'use strict';
// Der Operator bekam bisher die rohe SendCloud-Antwort ins Modal:
//   SendCloud create parcel 400: {"errors":[{"status":"400","code":
//   "validation_error","detail":"Please add the billing number for this product
//   in the DHL contract.","source":{"pointer":"non_field_errors"}}]}
// Daraus ist nicht ablesbar, WELCHES Produkt gemeint ist und wer es beheben
// kann (SendCloud-Einstellung, nicht avycloud). Ergebnis: Wiederholversuche
// mit demselben Produkt (Auftrag 10-14999-44761, 2026-08-07).
//
// translateSendCloudError() macht daraus einen Satz, der sagt, was zu tun ist —
// und lässt Unbekanntes unverändert durch, statt es zu verschlucken.

const { translateSendCloudError } = require('../lib/sendcloud-error-translate');

const billingBody = JSON.stringify({
  errors: [{
    status: '400', code: 'validation_error',
    detail: 'Please add the billing number for this product in the DHL contract.',
    source: { pointer: 'non_field_errors' },
  }],
});

describe('translateSendCloudError', () => {
  it('erklärt den DHL-Abrechnungsnummer-Fehler und nennt das Produkt', () => {
    const msg = translateSendCloudError(billingBody, { shippingOptionCode: 'dhl_de:europaket' });
    expect(msg).toMatch(/Abrechnungsnummer/i);
    expect(msg).toContain('dhl_de:europaket');
    expect(msg).toMatch(/SendCloud/);
  });

  it('erklärt den PLZ-Fehler', () => {
    const body = JSON.stringify({
      errors: [{ status: '400', code: 'validation_error', detail: 'Enter a valid zip code.', source: { pointer: 'postal_code' } }],
    });
    expect(translateSendCloudError(body, {})).toMatch(/PLZ|Postleitzahl/i);
  });

  // Incident 2026-08-10: der Operator las "…USt-IdNr… . Methode/Adresse/Guthaben
  // prüfen." und prüfte das Guthaben — die Nummer hängt aber am Absender-Datensatz.
  it('erklärt die fehlende USt-IdNr. und nennt den Ort (Absenderadresse, nicht Konto)', () => {
    const de = 'Für Auslandssendungen geben Sie bitte Ihre USt-IdNr. in Ihren Benutzerdaten an.';
    const msg = translateSendCloudError(de, {});
    expect(msg).toMatch(/USt-IdNr/);
    expect(msg).toMatch(/Absenderadresse/);
    expect(msg).not.toMatch(/Guthaben/);
  });

  it('erkennt auch die englische Variante des USt-IdNr.-Fehlers', () => {
    const body = JSON.stringify({ errors: [{ detail: 'Please provide your VAT number in your user settings.' }] });
    expect(translateSendCloudError(body, {})).toMatch(/USt-IdNr/);
  });

  it('explainSendCloudError meldet, ob eine Regel gegriffen hat', () => {
    const { explainSendCloudError } = require('../lib/sendcloud-error-translate');
    expect(explainSendCloudError('Ihre USt-IdNr. fehlt', {}).matched).toBe(true);
    expect(explainSendCloudError('Some brand new failure mode', {}).matched).toBe(false);
    expect(explainSendCloudError('Some brand new failure mode', {}).message).toContain('brand new');
  });

  it('gibt unbekannte Fehler unverändert zurück (nichts verschlucken)', () => {
    const body = JSON.stringify({ errors: [{ detail: 'Some brand new failure mode' }] });
    expect(translateSendCloudError(body, {})).toContain('Some brand new failure mode');
  });

  it('kommt mit Nicht-JSON klar', () => {
    expect(translateSendCloudError('<html>502 Bad Gateway</html>', {})).toContain('502');
  });

  it('kommt mit leerem Body klar', () => {
    expect(typeof translateSendCloudError('', {})).toBe('string');
  });
});
