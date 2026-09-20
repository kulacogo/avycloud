'use strict';
const sharp = require('sharp');

// Explicit rollback only. Batch "nurPixeltreu" keeps its original-pixel contract.
const photographicStudioEnabled = () => String(process.env.STUDIO_PHOTOGRAPHIC || '').trim() !== 'off';
const STUDIO_PHOTOGRAPHY_BRIEF = [
  'Create a premium commercial product photograph, with sculpted photographic depth and accurate colour.',
  'Use a large diffused key light above and to the left, gentle frontal fill one stop darker,',
  'and controlled edge separation. Show volume through gradual light falloff across the actual material.',
  'On metal retain restrained softbox highlights; on matte plastic or fabric keep the finish matte.',
  'Keep black material rich black, cream material cream and gold material gold. No global brightening of dark material.',
  'Place the product naturally on a seamless PURE WHITE background / studio sweep (#FFFFFF corners), with no visible horizon, no gradient, no vignette.',
  'Create a visible, physically plausible contact shadow: a narrow dark contact at the support points,',
  'softly feathering away beneath and slightly behind the product. Never floating, pasted-on, or a hard oval drop shadow.',
  'For a flat-lay keep realistic shallow contact shadows around the edges; do not make a flat object stand upright.',
  'Balance the composition for a square marketplace image: the entire product fills about 80–88% of the frame,',
  'comfortable breathing room, aligned verticals, level camera roll, no clipped extremities or oversized empty margins.',
  'Preserve the physical configuration and proportions; correct camera roll, not the product geometry.',
  'Remove the old room, table, seams and clutter. No props, no people, no added text, no watermark, no collage.',
  'Deliver the FINISHED studio photograph including its lighting and shadow, not a segmentation mask or flat cutout.',
].join(' ');

// Never segment a finished photograph again: that strips its lighting/shadow.
async function finishStudioCanvas(buffer) {
  const meta = await sharp(buffer).metadata();
  const size = Math.max(1600, meta.width || 0, meta.height || 0);
  const out = await sharp(buffer).resize(size, size, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
  return { buffer: out, mimeType: 'image/png', width: size, height: size };
}
module.exports = { photographicStudioEnabled, STUDIO_PHOTOGRAPHY_BRIEF, finishStudioCanvas };
