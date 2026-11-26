const test = require('node:test');
const assert = require('node:assert');
const { toMonochrome, trimBottom, encodeRaster, BAND_ROWS } = require('../src/escpos');

/** A BGRA bitmap from rows of '#' (black) and '.' (white). */
function bitmap(rows) {
  const width = rows[0].length;
  const bgra = Buffer.alloc(width * rows.length * 4);
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => {
      const v = c === '#' ? 0 : 255;
      bgra.set([v, v, v, 255], (y * width + x) * 4);
    })
  );
  return { bgra, width, height: rows.length };
}

test('dots are packed most significant bit first, 1 = black', () => {
  const { bgra, width, height } = bitmap(['#.......#.', '..........']);
  const mono = toMonochrome(bgra, width, height);
  assert.strictEqual(mono.widthBytes, 2);
  assert.deepStrictEqual([...mono.data], [0x80, 0x80, 0x00, 0x00]);
});

test('grey prints by threshold and transparent is paper', () => {
  const bgra = Buffer.from([100, 100, 100, 255, 200, 200, 200, 255, 0, 0, 0, 0]);
  const mono = toMonochrome(bgra, 3, 1);
  assert.deepStrictEqual([...mono.data], [0x80]);
});

test('blank rows at the bottom are not fed', () => {
  const { bgra, width, height } = bitmap(['#.......', '........', '#.......', '........', '........']);
  const trimmed = trimBottom(toMonochrome(bgra, width, height));
  assert.strictEqual(trimmed.height, 3);
});

test('a ticket is reset, raster bands, feed and cut', () => {
  const { bgra, width, height } = bitmap(['########', '#.......']);
  const out = encodeRaster(toMonochrome(bgra, width, height));
  assert.deepStrictEqual(
    [...out],
    [0x1b, 0x40, 0x1d, 0x76, 0x30, 0x00, 1, 0, 2, 0, 0xff, 0x80, 0x1b, 0x64, 4, 0x1d, 0x56, 0x42, 0x00]
  );
});

test('tall tickets are split into bands', () => {
  const rows = Array.from({ length: BAND_ROWS + 10 }, () => '#.......');
  const { bgra, width, height } = bitmap(rows);
  const out = encodeRaster(toMonochrome(bgra, width, height), { cut: false });
  const headers = [];
  for (let i = 0; i < out.length - 3; i += 1) {
    if (out[i] === 0x1d && out[i + 1] === 0x76 && out[i + 2] === 0x30) headers.push(out[i + 6] + out[i + 7] * 256);
  }
  assert.deepStrictEqual(headers, [BAND_ROWS, 10]);
});
