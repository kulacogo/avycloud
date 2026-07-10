const { normalizeKTypAttributeKeys, isKTypSynonymKey } = require('../../lib/ktype-key-normalize');

describe('normalizeKTypAttributeKeys', () => {
  it('folds the chat LLM key "ktype" onto canonical "K-Typ" (Incident 2026-07-10)', () => {
    const { attributes, changed, movedFrom } = normalizeKTypAttributeKeys({
      Marke: 'BOSCH',
      ktype: '18520,Vorderachse|31593,Vorderachse|59345,Vorderachse',
      Farbe: 'Silber',
    });
    expect(changed).toBe(true);
    expect(movedFrom).toEqual(['ktype']);
    expect(attributes['K-Typ']).toBe('18520,Vorderachse|31593,Vorderachse|59345,Vorderachse');
    expect(attributes.ktype).toBeUndefined();
    // other attrs untouched
    expect(attributes.Marke).toBe('BOSCH');
    expect(attributes.Farbe).toBe('Silber');
  });

  it('preserves the position of the first K-Typ key', () => {
    const { attributes } = normalizeKTypAttributeKeys({ a: '1', ktype: '111', b: '2' });
    expect(Object.keys(attributes)).toEqual(['a', 'K-Typ', 'b']);
  });

  it('is a no-op when the key is already canonical', () => {
    const input = { Marke: 'X', 'K-Typ': '111|222' };
    const { attributes, changed } = normalizeKTypAttributeKeys(input);
    expect(changed).toBe(false);
    expect(attributes).toBe(input);
  });

  it('when both canonical and synonym exist, the canonical non-empty value wins', () => {
    const { attributes, changed } = normalizeKTypAttributeKeys({ 'K-Typ': '999', ktype: '111' });
    expect(changed).toBe(true);
    expect(attributes['K-Typ']).toBe('999');
    expect(attributes.ktype).toBeUndefined();
  });

  it('drops an empty synonym key (no empty canonical)', () => {
    const { attributes, changed } = normalizeKTypAttributeKeys({ Marke: 'X', ktype: '' });
    expect(changed).toBe(true);
    expect(attributes['K-Typ']).toBeUndefined();
    expect(attributes.ktype).toBeUndefined();
    expect(attributes.Marke).toBe('X');
  });

  it('recognizes synonyms via alnum-normalization', () => {
    expect(isKTypSynonymKey('ktype')).toBe(true);
    expect(isKTypSynonymKey('K-Type')).toBe(true);
    expect(isKTypSynonymKey('kType_ID')).toBe(true);
    expect(isKTypSynonymKey('ktyp')).toBe(true);
    expect(isKTypSynonymKey('K-Typ')).toBe(true);
    // not K-Typ
    expect(isKTypSynonymKey('Material')).toBe(false);
    expect(isKTypSynonymKey('Typ')).toBe(false);
  });

  it('handles odd input without throwing', () => {
    expect(normalizeKTypAttributeKeys(null).changed).toBe(false);
    expect(normalizeKTypAttributeKeys(undefined).changed).toBe(false);
    expect(normalizeKTypAttributeKeys([]).changed).toBe(false);
  });
});
