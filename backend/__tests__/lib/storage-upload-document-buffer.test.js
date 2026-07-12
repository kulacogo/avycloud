'use strict';

/**
 * Unit-tests for uploadDocumentBuffer (lib/storage.js).
 *
 * Kernaussage: Dokument-Uploads (SDS-PDFs) laufen NICHT durch die sharp-
 * Bild-Normalisierung — der Buffer wird byte-identisch mit korrektem
 * contentType + public cacheControl unter products/{productId}/… gespeichert.
 *
 * Mocks via require.cache patching (Vitest 4.x CJS pattern):
 *   - @google-cloud/storage → in-memory fake, captured file.save() calls
 *   - sharp → spy that fails the test loudly if a document ever touches it
 */

const crypto = require('crypto');

function installModuleMock(modulePath, mockExports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
  return resolved;
}

// ─── Mock sharp: darf fuer Dokumente NIE aufgerufen werden ─────────────────
const sharpSpy = vi.fn(() => {
  throw new Error('sharp must not be called for document uploads');
});
installModuleMock('sharp', sharpSpy);

// ─── Mock @google-cloud/storage ────────────────────────────────────────────
const savedFiles = [];
class FakeFile {
  constructor(name) { this.name = name; }
  async save(buffer, options) { savedFiles.push({ name: this.name, buffer, options }); }
}
class FakeBucket {
  constructor(name) {
    this.name = name;
    this.iam = {
      getPolicy: async () => [{ bindings: [] }],
      setPolicy: async () => {},
    };
  }
  async exists() { return [true]; }
  async makePublic() { return; }
  file(name) { return new FakeFile(name); }
  async getFiles() { return [[]]; }
}
let _fakeBucket = null;
class FakeStorage {
  bucket(name) {
    if (!_fakeBucket) _fakeBucket = new FakeBucket(name);
    return _fakeBucket;
  }
  async createBucket() { return; }
}
installModuleMock('@google-cloud/storage', { Storage: FakeStorage });

// STORAGE_BUCKET nicht gesetzt → default 'prodsandjobs'
delete process.env.STORAGE_BUCKET;

// ─── SUT (nach den Mocks laden!) ───────────────────────────────────────────
const { uploadDocumentBuffer } = require('../../lib/storage');

beforeEach(() => {
  savedFiles.length = 0;
  sharpSpy.mockClear();
});

describe('uploadDocumentBuffer', () => {
  it('uploads a PDF byte-identical, WITHOUT sharp, with contentType + public cacheControl', async () => {
    const pdf = Buffer.from('%PDF-1.7\nSicherheitsdatenblatt fake content\n%%EOF', 'latin1');
    const expectedHash = crypto.createHash('md5').update(pdf).digest('hex');

    const res = await uploadDocumentBuffer(pdf, 'application/pdf', 'prod-123', 'sicherheitsdatenblatt');

    // sharp wurde NIE angefasst (PDFs wuerden dort brechen/verfaelscht)
    expect(sharpSpy).not.toHaveBeenCalled();

    expect(savedFiles).toHaveLength(1);
    const saved = savedFiles[0];
    // Pfad: products/${productId}/${name}_${md5hash}.${ext}
    expect(saved.name).toBe(`products/prod-123/sicherheitsdatenblatt_${expectedHash}.pdf`);
    expect(saved.options.metadata.contentType).toBe('application/pdf');
    expect(saved.options.metadata.cacheControl).toBe('public, max-age=31536000');
    // Buffer byte-identisch — keine Re-Encodierung
    expect(saved.buffer.equals(pdf)).toBe(true);

    expect(res).toEqual({
      url: `https://storage.googleapis.com/prodsandjobs/products/prod-123/sicherheitsdatenblatt_${expectedHash}.pdf`,
      mimeType: 'application/pdf',
      size: pdf.length,
    });
  });

  it('maps mime types to sane extensions (jpeg→jpg, svg+xml→svg, unknown→bin)', async () => {
    const buf = Buffer.from('not-really-an-image');
    const jpg = await uploadDocumentBuffer(buf, 'image/jpeg', 'p1', 'etikett');
    expect(jpg.url).toMatch(/\.jpg$/);
    const svg = await uploadDocumentBuffer(buf, 'image/svg+xml', 'p1', 'piktogramm');
    expect(svg.url).toMatch(/\.svg$/);
    const bin = await uploadDocumentBuffer(buf, 'application/x-whatever!', 'p1', 'blob');
    expect(bin.url).toMatch(/\.xwhatever$/);
    expect(sharpSpy).not.toHaveBeenCalled();
  });

  it('sanitizes the name segment', async () => {
    const buf = Buffer.from('%PDF-1.4 x', 'latin1');
    await uploadDocumentBuffer(buf, 'application/pdf', 'p2', 'SDS Blatt / märz');
    expect(savedFiles[0].name).toMatch(/^products\/p2\/SDS_Blatt___m_rz_[0-9a-f]{32}\.pdf$/);
  });

  it('rejects empty/non-Buffer input and missing productId', async () => {
    await expect(uploadDocumentBuffer(Buffer.alloc(0), 'application/pdf', 'p1', 'x')).rejects.toThrow(/non-empty Buffer/);
    await expect(uploadDocumentBuffer('nope', 'application/pdf', 'p1', 'x')).rejects.toThrow(/non-empty Buffer/);
    await expect(uploadDocumentBuffer(Buffer.from('%PDF-'), 'application/pdf', '', 'x')).rejects.toThrow(/productId/);
    expect(savedFiles).toHaveLength(0);
  });
});
