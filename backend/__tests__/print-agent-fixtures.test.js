'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');

describe('Windows print station installation labels', () => {
  it.each([['parcel', 103, 164], ['letter', 62, 100]])('%s has one page with exact roll dimensions', async (role, width, height) => {
    const file = path.join(__dirname, '../../tools/print-agent/fixtures', `${role}.pdf`);
    const doc = await PDFDocument.load(await fs.readFile(file));
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getWidth() * 25.4 / 72).toBeCloseTo(width, 3);
    expect(doc.getPage(0).getHeight() * 25.4 / 72).toBeCloseTo(height, 3);
    expect(doc.getTitle()).toBe(`AvyCloud Drucktest ${width}x${height} mm`);
  });
});
