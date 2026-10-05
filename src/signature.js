'use strict';

// A signature drawn on screen arrives as a PNG data URL. Returns { png } or { error }.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 60 * 1024;

function readSignature(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  const png = m ? Buffer.from(m[1], 'base64') : null;
  if (!png || png.length < 60 || !png.subarray(0, 8).equals(PNG)) return { error: 'Sign in the box first.' };
  if (png.length > MAX_BYTES) return { error: 'That signature is too large. Clear it and sign again.' };
  return { png };
}

module.exports = { readSignature };
