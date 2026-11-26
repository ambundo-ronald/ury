// Turns a picture of a ticket into ESC/POS, the command language of receipt
// printers (Xprinter, Epson TM, and most 58/80 mm thermal printers), so it
// can be sent to the printer directly instead of through a Windows driver.

// Dots across the printable width: 576 for 80 mm paper at 203 dpi.
const DOTS_80MM = 576;
// Rows per raster command. Some printers lose data on one very tall image.
const BAND_ROWS = 128;
// Darker than this (0-255) prints as black.
const THRESHOLD = 160;

const ESC = 0x1b;
const GS = 0x1d;

/**
 * Packs a BGRA bitmap (as from Electron's nativeImage.toBitmap()) into rows
 * of 1-bit dots, most significant bit first, 1 = black.
 * @returns {{ widthBytes: number, height: number, data: Buffer }}
 */
function toMonochrome(bgra, width, height, threshold = THRESHOLD) {
  const widthBytes = Math.ceil(width / 8);
  const data = Buffer.alloc(widthBytes * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const alpha = bgra[i + 3] / 255;
      // Transparent counts as white paper.
      const luminance = (0.114 * bgra[i] + 0.587 * bgra[i + 1] + 0.299 * bgra[i + 2]) * alpha + 255 * (1 - alpha);
      if (luminance < threshold) data[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { widthBytes, height, data };
}

/** Drops blank rows at the bottom, so the paper is not fed for nothing. */
function trimBottom({ widthBytes, height, data }) {
  let last = height;
  while (last > 0) {
    const row = data.subarray((last - 1) * widthBytes, last * widthBytes);
    if (row.some((b) => b !== 0)) break;
    last -= 1;
  }
  return { widthBytes, height: last, data: data.subarray(0, last * widthBytes) };
}

/**
 * ESC/POS for a whole ticket: reset, the picture in bands (GS v 0), feed,
 * and a partial cut. Printers without a cutter ignore the cut.
 */
function encodeRaster(mono, { feedLines = 4, cut = true } = {}) {
  const { widthBytes, height, data } = trimBottom(mono);
  const parts = [Buffer.from([ESC, 0x40])];
  for (let top = 0; top < height; top += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, height - top);
    parts.push(
      Buffer.from([GS, 0x76, 0x30, 0x00, widthBytes & 0xff, widthBytes >> 8, rows & 0xff, rows >> 8]),
      data.subarray(top * widthBytes, (top + rows) * widthBytes)
    );
  }
  parts.push(Buffer.from([ESC, 0x64, feedLines]));
  if (cut) parts.push(Buffer.from([GS, 0x56, 0x42, 0x00]));
  return Buffer.concat(parts);
}

module.exports = { toMonochrome, trimBottom, encodeRaster, DOTS_80MM, BAND_ROWS };
