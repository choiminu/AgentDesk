// pixelkit: the drawing kit's core (canvas, color, seeded randomness, PNG in and out), the character sheets'
// sizes and layout, tiles that meet themselves, nine-slice UI, and the verdicts of the checker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Canvas, hex, toHex, mix, fit, at, shade, tint, alpha, INK, rand, hash, Rng, seedOf, tileNoise, encodePNG, decodePNG, toPNG, fromPNG, loadPNG, textWidth } from '../pixelkit/core/index.js';
import * as C from '../pixelkit/char/index.js';
import * as T from '../pixelkit/tile/index.js';
import * as U from '../pixelkit/ui/index.js';
import { CATALOG, byId, select } from '../pixelkit/catalog.js';
import { appFiles, APP_CHARS } from '../pixelkit/app.js';
import * as K from '../pixelkit/tools/lib/checks.mjs';
import { contactSheet, frames } from '../pixelkit/tools/lib/sheet.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KIT = join(ROOT, 'pixelkit');
const RED = hex('#ff0000'), BLUE = hex('#0000ff');

// ── core ──
test('color: hex both ways, mixing, ramps pick a step and never blend', () => {
  assert.equal(toHex(hex('#4f8fe0')), '#4f8fe0');
  assert.equal(hex('#fa0'), hex('#ffaa00'));
  assert.equal(alpha(hex('#11223380')), 0x80);
  assert.equal(toHex(mix('#000000', '#ffffff', 0.5)), '#808080');
  assert.ok(toHex(shade(hex('#ffffff'))) !== '#ffffff' && toHex(tint(hex('#000000'))) !== '#000000');
  const r = ['#000000', '#555555', '#aaaaaa', '#ffffff'].map(hex);
  assert.equal(at(r, 0), r[0]); assert.equal(at(r, 0.49), r[1]); assert.equal(at(r, 1), r[3]);
  assert.deepEqual(fit(r, 2), [r[0], r[3]]);
  assert.equal(fit(r, 7).length, 7);
});

test('randomness is seeded: the same seed gives the same numbers, a different seed different ones', () => {
  const a = new Rng(42), b = new Rng(42), c = new Rng(43);
  const run = (r) => Array.from({ length: 8 }, () => r.next());
  const ra = run(a);
  assert.deepEqual(ra, run(b));
  assert.notDeepEqual(ra, run(c));
  assert.ok(ra.every((v) => v >= 0 && v < 1));
  assert.equal(rand(1, 2, 3), rand(1, 2, 3));
  assert.notEqual(hash(1, 2), hash(2, 1));
  assert.equal(new Rng('desk').next(), new Rng(seedOf('desk')).next());
  for (let i = 0; i < 50; i++) { const v = new Rng(i + 1).int(3, 5); assert.ok(v >= 3 && v <= 5); }
  // noise that repeats: one period on, the value is the same
  assert.equal(tileNoise(1.3, 2.7, 4, 4, 9), tileNoise(5.3, 6.7, 4, 4, 9));
});

test('canvas: pixels, shapes, and a color of 0 that never erases', () => {
  const g = new Canvas(8, 8);
  g.set(1, 1, RED).set(1, 1, 0).set(-1, 0, RED).set(8, 8, RED);
  assert.equal(g.get(1, 1), RED);
  assert.equal(g.get(-1, 0), 0);
  assert.equal(g.colors().size, 1);
  g.clear();
  g.rect(2, 2, 3, 2, BLUE);
  assert.equal(g.data.filter((c) => c === BLUE).length, 6);
  g.clear().line(0, 0, 7, 7, RED);
  for (let i = 0; i < 8; i++) assert.equal(g.get(i, i), RED);
  g.clear().line(6, 1, 1, 3, RED);
  assert.ok(g.get(6, 1) && g.get(1, 3), 'a line includes both ends');
  g.clear().frame(0, 0, 8, 8, RED);
  assert.equal(g.data.filter(Boolean).length, 28);
  assert.throws(() => new Canvas(0, 4));
});

test('canvas: a circle is symmetric, its ring is its rim', () => {
  const g = new Canvas(16, 16).circle(7.5, 7.5, 5, RED);
  assert.ok(g.equals(g.flipX()), 'left-right');
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) assert.equal(g.get(x, y), g.get(y, x), 'diagonal');
  const ring = new Canvas(16, 16).ring(7.5, 7.5, 5, BLUE);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (ring.get(x, y)) assert.ok(g.get(x, y), 'the ring lies on the disc');
  assert.equal(ring.get(7, 7), 0);
});

test('canvas: dither keeps pixels by the 4 x 4 grid, never blends', () => {
  for (const [a, n] of [[0, 0], [0.25, 16], [0.5, 32], [0.75, 48], [1, 64]]) {
    const g = new Canvas(8, 8).rect(0, 0, 8, 8, RED, a);
    assert.equal(g.data.filter(Boolean).length, n, `coverage ${a}`);
    assert.ok(g.colors().size <= 1);
  }
  const half = new Canvas(8, 8).rect(0, 0, 8, 8, RED, 0.5);
  assert.notEqual(half.get(0, 0), half.get(1, 0), 'half coverage is a checkerboard');
  const bands = new Canvas(16, 32).bands(0, 0, 16, 32, [RED, BLUE], { soft: 3 });
  assert.equal(bands.colors().size, 2);
  assert.equal(bands.get(0, 0), RED); assert.equal(bands.get(15, 31), BLUE);
});

test('canvas: outline, mirror, sprite, crop, scale', () => {
  const g = new Canvas(8, 8).rect(3, 3, 2, 2, RED).outline(INK);
  assert.equal(g.data.filter((c) => c === INK).length, 8, 'four sides of a 2 x 2, no corners');
  assert.equal(g.get(2, 2), 0);
  assert.equal(new Canvas(8, 8).rect(3, 3, 2, 2, RED).outline(INK, 0, 0, 8, 8, { corners: true }).data.filter((c) => c === INK).length, 12);
  // an outline stays inside its box
  const edge = new Canvas(4, 4).rect(0, 0, 2, 2, RED).outline(INK, 0, 0, 2, 2);
  assert.equal(edge.data.filter((c) => c === INK).length, 0);

  const s = new Canvas(3, 2).sprite(['#..', '.oo'], { '#': RED, o: '#0000ff' });
  assert.equal(s.get(0, 0), RED); assert.equal(s.get(2, 1), BLUE); assert.equal(s.get(1, 0), 0);
  assert.equal(s.flipX().get(2, 0), RED);
  assert.ok(s.flipX().flipX().equals(s));
  assert.throws(() => new Canvas(2, 1).sprite(['?'], {}), /no color/);
  assert.equal(new Canvas(3, 2).sprite(['#..', '.oo'], { '#': RED, o: BLUE }, 0, 0, { flip: true }).get(2, 0), RED);

  const big = s.scaled(3);
  assert.deepEqual([big.w, big.h], [9, 6]);
  assert.equal(big.get(2, 2), RED); assert.equal(big.get(3, 2), 0);
  assert.ok(big.crop(0, 0, 3, 3).data.every((c) => c === RED));
  const dst = new Canvas(3, 2, BLUE).blit(new Canvas(3, 2).set(1, 0, RED));
  assert.equal(dst.get(1, 0), RED); assert.equal(dst.get(0, 0), BLUE, 'blit skips empty pixels');
});

test('png: what is written reads back the same', () => {
  const g = new Canvas(5, 3);
  g.set(0, 0, RED).set(4, 2, BLUE).set(2, 1, hex('#12345680'));
  const back = fromPNG(toPNG(g));
  assert.ok(back.equals(g));
  const { w, h, data } = decodePNG(encodePNG(2, 1, new Uint8Array([1, 2, 3, 255, 9, 8, 7, 0])));
  assert.deepEqual([w, h, ...data], [2, 1, 1, 2, 3, 255, 9, 8, 7, 0]);
  assert.throws(() => decodePNG(Buffer.from('not a png at all')), /not a PNG/);
});

// a PNG file from parts, to read kinds the kit's own writer never makes
function png(w, h, depth, type, rows, extra = []) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const len = Buffer.alloc(4), body = Buffer.concat([Buffer.from(name, 'ascii'), data]), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = type;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...extra.map(([n, d]) => chunk(n, Buffer.from(d))), chunk('IDAT', deflateSync(Buffer.from(rows.flat()))), chunk('IEND', Buffer.alloc(0))]);
}

test('png: reads RGB, grey, palette (with transparency, also under 8 bits) and every row filter', () => {
  // RGB, row filters 0 (none), 1 (sub), 2 (up)
  const rgb = decodePNG(png(2, 3, 8, 2, [[0, 10, 20, 30, 40, 50, 60], [1, 10, 20, 30, 30, 30, 30], [2, 0, 0, 0, 0, 0, 0]]));
  assert.deepEqual([...rgb.data], [10, 20, 30, 255, 40, 50, 60, 255, 10, 20, 30, 255, 40, 50, 60, 255, 10, 20, 30, 255, 40, 50, 60, 255]);
  // filters 3 (average) and 4 (Paeth) undo to the same row
  const avg = decodePNG(png(2, 2, 8, 0, [[0, 100, 50], [3, 50, 25]]));
  assert.deepEqual([...avg.data].filter((_, i) => i % 4 === 0), [100, 50, 100, 100]);
  const paeth = decodePNG(png(2, 2, 8, 0, [[0, 100, 50], [4, 0, 0]]));
  assert.deepEqual([...paeth.data].filter((_, i) => i % 4 === 0), [100, 50, 100, 50]);
  // grey + alpha
  assert.deepEqual([...decodePNG(png(1, 1, 8, 4, [[0, 200, 128]])).data], [200, 200, 200, 128]);
  // palette, 8 bits, the first entry transparent
  const pal = decodePNG(png(3, 1, 8, 3, [[0, 0, 1, 2]], [['PLTE', [255, 0, 0, 0, 255, 0, 0, 0, 255]], ['tRNS', [0]]]));
  assert.deepEqual([...pal.data], [255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255]);
  // palette, 2 bits a pixel: four pixels in one byte
  const two = decodePNG(png(4, 1, 2, 3, [[0, 0b00011011]], [['PLTE', [0, 0, 0, 10, 10, 10, 20, 20, 20, 30, 30, 30]]]));
  assert.deepEqual([...two.data].filter((_, i) => i % 4 === 0), [0, 10, 20, 30]);
  // what it does not read, it says
  assert.throws(() => decodePNG(png(1, 1, 16, 2, [[0, 0, 0, 0, 0, 0, 0]])), /16-bit/);
  assert.throws(() => decodePNG(png(1, 1, 8, 3, [[0, 0]])), /no PLTE/);
});

test('png: reads the art already in the repo, RGBA and RGB alike', () => {
  const town = loadPNG(join(ROOT, 'assets', 'pixel', 'town', 'char_0.png'));
  assert.deepEqual([town.w, town.h], [112, 96]);
  assert.ok(town.colors().size > 4);
  const wall = loadPNG(join(ROOT, 'assets', 'pixel', 'wall.png'));   // saved without an alpha channel
  assert.ok(wall.w > 0 && wall.data.every((c) => alpha(c) === 255));
});

// ── characters ──
test('characters: the base sheet is 112 x 96 — 7 frames x 3 rows of 16 x 32 — like the sheets the office loads', () => {
  const existing = loadPNG(join(ROOT, 'assets', 'pixel', 'town', 'char_0.png'));
  assert.deepEqual(C.BASE_POSES, ['walkA', 'stand', 'walkB', 'typeA', 'typeB', 'readA', 'readB']);
  assert.deepEqual(C.VIEWS, ['down', 'up', 'side']);
  assert.ok(Object.keys(C.PRESETS).length >= 8);
  for (const [name, preset] of Object.entries(C.PRESETS)) {
    const sheet = C.baseSheet(preset);
    assert.deepEqual([sheet.w, sheet.h], [existing.w, existing.h], name);
    const cells = frames(sheet, 16, 32);
    assert.equal(cells.length, 21);
    for (const [i, f] of cells.entries()) {
      assert.ok(f.data.filter(Boolean).length > 120, `${name} frame ${i} is drawn`);
      assert.equal(K.clipped(f).length, 0, `${name} frame ${i} fits its frame`);
    }
    // standing: feet on the same row as the existing sheets' feet; seated: three pixels lower at the head
    const top = (f) => { for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++) if (f.get(x, y)) return y; };
    const bottom = (f) => { for (let y = 31; y >= 0; y--) for (let x = 0; x < 16; x++) if (f.get(x, y)) return y; };
    assert.equal(bottom(cells[1]), bottom(existing.crop(16, 0, 16, 32)), `${name} stands where the old sheet stands`);
    if (!preset.hat && !['bun', 'spiky', 'tuft'].includes(preset.hair.style)) assert.equal(top(cells[3]) - top(cells[1]), 3, `${name} sits 3 px lower`);
  }
});

test('characters: umbrella, jump and carry sheets have 2 or more frames each, in the same three rows', () => {
  assert.deepEqual(Object.keys(C.ACTIONS).sort(), ['carry', 'jump', 'umbrella']);
  for (const [action, poses] of Object.entries(C.ACTIONS)) {
    assert.ok(poses.length >= 2, action);
    const sheet = C.actionSheet(C.PRESETS.sky, action);
    assert.deepEqual([sheet.w, sheet.h], [poses.length * 16, 96]);
    const cells = frames(sheet, 16, 32);
    for (let r = 0; r < 3; r++)
      for (let f = 1; f < poses.length; f++) assert.ok(!cells[r * poses.length + f].equals(cells[r * poses.length + f - 1]), `${action} row ${r}: frame ${f} moves`);
  }
  // the three actions are different pictures from standing still, in every view
  for (const view of C.VIEWS) for (const pose of ['umbrellaA', 'jumpC', 'carryA']) assert.ok(!C.frame(C.PRESETS.sky, view, pose).equals(C.frame(C.PRESETS.sky, view, 'stand')), `${pose} ${view}`);
  // a jump leaves the ground and comes back
  const feet = (pose) => { const f = C.frame(C.PRESETS.sky, 'down', pose); for (let y = 31; y >= 0; y--) for (let x = 0; x < 16; x++) if (f.get(x, y)) return y; };
  assert.ok(feet('jumpC') < feet('jumpB') && feet('jumpB') < feet('jumpA'));
  assert.equal(feet('jumpD'), feet('stand'));
  assert.throws(() => C.actionSheet(C.PRESETS.sky, 'fly'), /unknown action/);
});

test('characters: parts combine, and each part changes the picture', () => {
  const base = { skin: 'fair', hair: { style: 'short', color: 'brown' }, top: { kind: 'tee', color: '#4f8fe0' }, bottom: { kind: 'pants', color: '#3b4a6b' } };
  const pic = (over, view = 'down') => C.frame({ ...base, ...over }, view, 'stand');
  const plain = pic({});
  for (const skin of Object.keys(C.SKIN).slice(1)) assert.ok(!pic({ skin }).equals(plain), skin);
  for (const style of Object.keys(C.HAIR_STYLES)) if (style !== 'short') assert.ok(C.VIEWS.some((v) => !pic({ hair: { style, color: 'brown' } }, v).equals(pic({}, v))), style);
  for (const kind of C.TOPS.slice(1)) assert.ok(!pic({ top: { kind, color: '#4f8fe0' } }).equals(plain), kind);
  assert.ok(!pic({ top: { kind: 'tee', color: '#4f8fe0', sleeve: 'short' } }).equals(plain), 'short sleeves');
  for (const kind of C.BOTTOMS.slice(1)) assert.ok(!pic({ bottom: { kind, color: '#3b4a6b' } }).equals(plain), kind);
  for (const kind of C.HATS) assert.ok(!pic({ hat: { kind } }).equals(plain), kind);
  for (const prop of C.PROPS) assert.ok(!pic({ props: [prop] }).equals(plain), prop);
  assert.ok(C.PROPS.length >= 4 && C.TOPS.length >= 5 && Object.keys(C.HAIR_STYLES).length >= 8);
  // a name that is not in the tables is an error, not a silent default
  assert.throws(() => C.character({ skin: 'green' }), /unknown skin/);
  assert.throws(() => C.character({ hair: { style: 'mohawk' } }), /unknown hair style/);
  assert.throws(() => C.character({ top: { kind: 'cape' } }), /unknown top/);
  assert.throws(() => C.character({ props: ['wings'] }), /unknown prop/);
  assert.throws(() => C.frame(base, 'down', 'dance'), /unknown pose/);
  assert.throws(() => C.frame(base, 'left', 'stand'), /unknown view/);
});

test('characters: the same input is the same picture', () => {
  assert.ok(C.baseSheet(C.PRESETS.rose).equals(C.baseSheet(C.PRESETS.rose)));
  assert.deepEqual(C.randomCharacter(7), C.randomCharacter(7));
  assert.deepEqual(C.randomCharacter('front-desk'), C.randomCharacter('front-desk'));
  const looks = new Set(Array.from({ length: 12 }, (_, i) => JSON.stringify(C.randomCharacter(i + 1))));
  assert.ok(looks.size >= 10, 'different seeds, different people');
  for (let i = 1; i <= 12; i++) assert.equal(K.clipped(C.baseSheet(C.randomCharacter(i)), { frame: [16, 32] }).length, 0, `seed ${i} fits`);
});

// ── tiles ──
test('tiles: every floor is 16 x 16, solid, and meets itself on all four sides', () => {
  assert.ok(Object.keys(T.FLOORS).length >= 5);
  for (const kind of Object.keys(T.FLOORS)) {
    const f = T.floor(kind);
    assert.deepEqual([f.w, f.h], [16, 16], kind);
    assert.equal(K.emptyPixels(f), 0, kind);
    assert.ok(T.seamReport(f).ok, `${kind}: ${JSON.stringify(T.seamReport(f))}`);
    assert.ok(T.floor(kind, { seed: 5 }).equals(T.floor(kind, { seed: 5 })), `${kind} repeats from its seed`);
    assert.ok(T.seamReport(T.floor(kind, { seed: 5 })).ok, `${kind} with another seed`);
  }
  assert.throws(() => T.floor('lava'), /unknown floor/);
});

test('tiles: the seam check tells a tile that repeats from one that does not', () => {
  // a ramp from dark to bright: fine inside, a hard jump where it wraps
  const rampTile = new Canvas(16, 16);
  for (let x = 0; x < 16; x++) rampTile.vline(x, 0, 15, hex(`#${(x * 16).toString(16).padStart(2, '0').repeat(3)}`));
  const r = T.seamReport(rampTile);
  assert.equal(r.x.ok, false); assert.equal(r.y.ok, true); assert.equal(r.ok, false);
  assert.ok(T.seamReport(rampTile, { x: false }).ok, 'only the sides that were asked for are judged');
  // a flat tile, and stripes exactly one period wide, repeat
  assert.ok(T.seamReport(new Canvas(16, 16, RED)).ok);
  const stripes = new Canvas(16, 16, RED); for (let x = 0; x < 16; x += 4) stripes.vline(x, 0, 15, BLUE);
  assert.ok(T.seamReport(stripes).ok);
  // the verdict does not depend on where the pattern starts: the same floor, rolled sideways, still passes
  const slab = T.floor('slab'), rolled = new Canvas(16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) rolled.set((x + 5) % 16, (y + 3) % 16, slab.get(x, y));
  assert.ok(T.seamReport(slab).ok && T.seamReport(rolled).ok);
  // a busy edge next to a calm inside fails: one board line inside, but the wrap breaks on every row
  const calm = new Canvas(16, 16, RED).hline(8, 0, 15, BLUE).vline(15, 0, 15, BLUE).vline(0, 0, 15, INK);
  assert.equal(T.seamReport(calm).x.ok, true, 'a hard line at the edge is no busier than one inside would be');
  const half = new Canvas(16, 16, RED).rect(0, 0, 8, 16, BLUE);
  for (let x = 0; x < 8; x++) half.vline(x, 0, 15, x % 2 ? RED : BLUE);
  assert.equal(T.seamReport(half).x.ok, true, 'stripes that happen to end at the edge repeat');
  // the limit of the measure, on record: a patch that stops at the edge looks the same to it as one that stops
  // inside, so this passes — tiled() and eyes are what catch it
  assert.equal(T.seamReport(new Canvas(16, 16, RED).rect(13, 2, 3, 12, BLUE)).x.ok, true);
  // a sky's bands do not repeat downwards, and that is why only left-right is asked of it
  assert.equal(T.seamReport(T.sky('dusk')).y.ok, false);
  assert.ok(T.seamReport(T.sky('dusk'), { y: false }).ok);
  assert.deepEqual([T.tiled(slab, 3, 2).w, T.tiled(slab, 3, 2).h], [48, 32]);
});

test('tiles: walls, sky and building pieces have their sizes and meet their neighbours', () => {
  for (const kind of Object.keys(T.WALLS)) {
    const w = T.wall(kind);
    assert.deepEqual([w.w, w.h], [16, 32], kind);
    assert.ok(T.seamReport(w, { y: false }).ok, kind);
  }
  const win = T.wallWindow();
  assert.deepEqual([win.w, win.h], [32, 32]);
  assert.ok(T.joinReport(T.wall('plain'), win, 'right').ok && T.joinReport(win, T.wall('plain'), 'right').ok);
  assert.equal(T.joinReport(T.wall('plain'), T.wall('plain', { color: '#3b4257' }), 'right').ok, false, 'two different paints do not join');
  assert.equal(T.joinReport(T.wall('plain'), T.floor('slab'), 'right').ok, false, 'different heights do not join');
  for (const kind of ['sky', 'dusk', 'night']) { const s = T.sky(kind); assert.deepEqual([s.w, s.h], [32, 64]); assert.equal(K.emptyPixels(s), 0); }
  assert.throws(() => T.sky('sky', { w: 30 }), /multiple of 4/);
  assert.ok(T.seamReport(T.skyline({ seed: 3 }), { y: false }).ok);
  assert.ok(K.emptyPixels(T.cloud()) > 0 && T.cloud().colors().size <= 2);
  for (const piece of [T.facade(), T.windowPiece(), T.windowPiece({ lit: true }), T.roofPiece(), T.awningPiece()]) assert.deepEqual([piece.w, piece.h], [16, 16]);
  assert.ok(T.joinReport(T.facade(), T.windowPiece(), 'right').ok && T.joinReport(T.windowPiece(), T.facade(), 'below').ok);
  assert.deepEqual([T.doorPiece().w, T.doorPiece().h], [16, 32]);
  const b = T.building({ cols: 3, floors: 2, seed: 2 });
  assert.deepEqual([b.w, b.h], [3 * 16 + 2, 16 + 2 * 16 + 32 + 2]);
  assert.ok(b.equals(T.building({ cols: 3, floors: 2, seed: 2 })) && !b.equals(T.building({ cols: 3, floors: 2, seed: 3, lit: 1 })));
});

// ── menu UI ──
test('ui: nine-slice keeps the corners and repeats the rest', () => {
  const src = new Canvas(6, 6, BLUE);
  src.set(0, 0, RED).set(5, 0, RED).set(0, 5, RED).set(5, 5, RED).set(2, 2, INK);
  const out = U.nineSlice(src, 2, 15, 9);
  assert.deepEqual([out.w, out.h], [15, 9]);
  for (const [x, y] of [[0, 0], [14, 0], [0, 8], [14, 8]]) assert.equal(out.get(x, y), RED);
  assert.equal(out.data.filter((c) => c === RED).length, 4, 'corners are not repeated');
  assert.ok(out.data.filter((c) => c === INK).length > 1, 'the middle is');
  assert.ok(U.nineSlice(src, 2, 6, 6).equals(src), 'at its own size a source comes back unchanged');
  assert.throws(() => U.nineSlice(src, 2, 3, 9), /smaller than the corners/);
  assert.throws(() => U.nineSlice(src, 3, 20, 20), /no middle/);
});

test('ui: panels size to anything; a button keeps its box in all three states', () => {
  for (const style of Object.keys(U.PANELS)) {
    const p = U.panel(style, 70, 41);
    assert.deepEqual([p.w, p.h], [70, 41], style);
    assert.equal(p.get(35, 0), INK, `${style} has its top line`);
    assert.equal(p.get(0, 0), 0, `${style} has a rounded corner`);
    assert.deepEqual([U.panelSource(style).w, U.panelSource(style).h], [24, 24]);
  }
  assert.ok(!U.panel('window', 80, 40, { title: 'HELLO' }).equals(U.panel('window', 80, 40)));
  assert.throws(() => U.panel('glass', 40, 40), /unknown panel/);

  assert.deepEqual(U.BUTTON_STATES, ['normal', 'raised', 'pressed']);
  const [normal, raised, pressed] = U.BUTTON_STATES.map((s) => U.button(s, 48, 18, { label: 'OK' }));
  for (const b of [normal, raised, pressed]) assert.deepEqual([b.w, b.h], [48, 18]);
  assert.ok(!normal.equals(raised) && !normal.equals(pressed) && !raised.equals(pressed));
  const top = (b) => { for (let y = 0; y < b.h; y++) if (b.get(24, y)) return y; };
  assert.ok(top(raised) < top(normal) && top(normal) < top(pressed), 'raised sits higher, pressed lower');
  for (const b of [normal, raised, pressed]) assert.equal(b.get(24, 17), INK, 'the foot stays on the same row');
  // a tall button has no stripe: every row of the face between its top and bottom edges is the same
  for (const s of U.BUTTON_STATES) { const tall = U.button(s, 30, 40); assert.equal(tall.get(15, 12), tall.get(15, 24), s); }
  assert.throws(() => U.button('hover', 40), /unknown button state/);
  assert.throws(() => U.button('normal', 40, 16, { color: 'plaid' }), /unknown ramp/);
  assert.ok(!U.button('normal', 26, 22, { icon: U.icon('gear') }).equals(U.button('normal', 26, 22)));
});

test('ui: eight or more 16 x 16 icons, the menu set among them', () => {
  assert.ok(U.ICON_NAMES.length >= 8);
  for (const name of ['gear', 'book', 'sword', 'bell', 'plus', 'close', 'refresh', 'play']) assert.ok(U.ICON_NAMES.includes(name), name);
  const seen = new Set();
  for (const name of U.ICON_NAMES) {
    const i = U.icon(name);
    assert.deepEqual([i.w, i.h], [16, 16], name);
    assert.ok(i.data.filter(Boolean).length >= 40, `${name} is drawn`);
    assert.ok(i.data.includes(INK), `${name} is outlined`);
    assert.equal(K.clipped(i).length, 0, `${name} fits`);
    seen.add(i.data.join());
  }
  assert.equal(seen.size, U.ICON_NAMES.length, 'no two icons are the same picture');
  assert.throws(() => U.icon('unicorn'), /unknown icon/);
});

// ── the checker ──
test('checks: size, colors, stray and lone pixels, translucency, clipping', () => {
  const g = new Canvas(32, 32);
  assert.deepEqual(K.sizeProblems(g, { size: [32, 32], frame: [16, 32] }), []);
  assert.match(K.sizeProblems(g, { size: [112, 96] })[0], /expected 112 x 96/);
  assert.match(K.sizeProblems(new Canvas(30, 32), { frame: [16, 32] })[0], /whole number/);

  g.rect(4, 4, 6, 6, RED).set(6, 6, BLUE).set(20, 20, BLUE);
  assert.equal(K.colorCount(g), 2);
  assert.deepEqual(K.strays(g), [[20, 20]], 'a dot with nothing around it');
  assert.deepEqual(K.lonePixels(g), [[6, 6], [20, 20]], 'a dot with no neighbour of its own color');
  // on a tile, the other side is next door
  const t = new Canvas(8, 8, RED).set(0, 3, BLUE).set(7, 3, BLUE);
  assert.equal(K.lonePixels(t).length, 2);
  assert.equal(K.lonePixels(t, { wrapX: true }).length, 0);

  assert.equal(K.softPixels(g), 0);
  assert.equal(K.softPixels(new Canvas(2, 2).set(0, 0, hex('#ff000080'))), 1);
  assert.equal(K.emptyPixels(new Canvas(4, 4).rect(0, 0, 4, 3, RED)), 4);

  const sprite = new Canvas(16, 16).rect(1, 1, 14, 14, RED).outline(INK);
  assert.equal(K.clipped(sprite).length, 0, 'ink on the border is the outline, not a cut');
  assert.equal(K.clipped(new Canvas(16, 16).rect(0, 4, 5, 5, RED)).length, 5, 'fill on the border is cut off');
  assert.ok(K.clipped(sprite, { margin: 1 }).length > 0, 'a margin wants the border empty');
  const two = new Canvas(32, 16).rect(14, 4, 4, 4, RED);   // straddles two 16 px frames
  assert.equal(K.clipped(two).length, 0);
  assert.equal(K.clipped(two, { frame: [16, 16] }).length, 8);
});

test('checks: unseeded randomness is found in source, and there is none in pixelkit', () => {
  const call = ['Math', 'random()'].join('.');
  assert.ok(K.usesUnseeded(`const x = ${call} * 3;`));
  assert.ok(!K.usesUnseeded('const r = new Rng(3); r.next();'));
  assert.deepEqual(K.unseeded(KIT), []);
});

test('checks: an item passes or fails for the reason its spec gives', () => {
  const good = { id: 'good', draw: () => new Canvas(16, 16, RED), spec: { size: [16, 16], opaque: true, maxColors: 2, tile: { x: true, y: true } } };
  assert.deepEqual(K.checkItem(good), { errors: [], notes: [] });
  const errorsOf = (draw, spec, map) => K.checkItem({ id: 'x', draw, spec }, map).errors.join(' | ');
  assert.match(errorsOf(() => new Canvas(16, 15, RED), { size: [16, 16] }), /expected 16 x 16/);
  assert.match(errorsOf(() => new Canvas(4, 4).set(0, 0, RED).set(1, 0, BLUE).set(2, 0, INK), { maxColors: 2 }), /3 colors/);
  assert.match(errorsOf(() => new Canvas(4, 4, hex('#ff000080')), {}), /translucent/);
  assert.equal(errorsOf(() => new Canvas(4, 4, hex('#ff000080')), { soft: true }), '');
  assert.match(errorsOf(() => new Canvas(8, 8).rect(0, 0, 3, 3, RED).set(6, 6, RED), {}), /stray pixel/);
  assert.match(errorsOf(() => new Canvas(4, 4).rect(0, 0, 4, 2, RED), { opaque: true }), /empty pixels/);
  assert.match(errorsOf(() => new Canvas(16, 16).rect(0, 0, 4, 4, RED), { clip: true }), /cut off/);
  const rampTile = () => { const g = new Canvas(16, 16); for (let x = 0; x < 16; x++) g.vline(x, 0, 15, hex(`#${(x * 16).toString(16).padStart(2, '0').repeat(3)}`)); return g; };
  assert.match(errorsOf(rampTile, { tile: { x: true } }), /seam when repeated left to right/);
  assert.equal(errorsOf(rampTile, { tile: { y: true } }), '');
  assert.match(errorsOf(() => new Canvas(4, 4), {}), /draws nothing/);
  assert.match(errorsOf(() => { throw new Error('boom'); }, {}), /does not draw: boom/);
  let n = 0;
  assert.match(errorsOf(() => new Canvas(4, 4, n++ ? RED : BLUE), {}), /not deterministic/);
  assert.match(errorsOf(() => new Canvas(16, 16, RED), { joins: [{ with: 'good' }] }, new Map()), /not in the catalog/);
  assert.match(errorsOf(() => new Canvas(16, 16, BLUE), { joins: [{ with: 'good' }] }, new Map([['good', good]])), /does not meet good/);
  // speckle is a note, not a failure
  const speckled = K.checkItem({ id: 's', draw: () => { const g = new Canvas(16, 16, RED); for (let i = 1; i < 16; i += 3) g.set(i, i, BLUE); return g; }, spec: { maxLone: 2 } });
  assert.equal(speckled.errors.length, 0);
  assert.match(speckled.notes[0], /lone pixels/);
});

test('checks: everything in the catalog passes, and the catalog covers characters, tiles and UI', () => {
  const failed = CATALOG.map((it) => [it.id, K.checkItem(it, byId)]).filter(([, r]) => r.errors.length || r.notes.length);
  assert.deepEqual(failed, []);
  for (const group of ['char', 'tile', 'ui']) assert.ok(select([group]).length >= 10, group);
  assert.equal(new Set(CATALOG.map((it) => it.id)).size, CATALOG.length, 'ids are unique');
  assert.deepEqual(select(['floor/plank']).map((it) => it.id), ['floor/plank']);
  assert.ok(select(['icon/*']).length >= 8 && select(['floor']).length === Object.keys(T.FLOORS).length);
  assert.throws(() => select(['nothing-like-this']), /matches/);
});

// ── the tools ──
test('tools: check.mjs exits 0 on the catalog and 1 on a name it does not know', () => {
  const out = execFileSync(process.execPath, [join(KIT, 'tools', 'check.mjs')], { encoding: 'utf8' });
  assert.match(out, /\d+ drawings: \d+ pass, 0 fail, 0 with notes/);
  assert.equal(spawnSync(process.execPath, [join(KIT, 'tools', 'check.mjs'), 'nothing-like-this']).status, 1);
});

test('tools: render.mjs writes a contact sheet that is a readable PNG, enlarged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pixelkit-'));
  try {
    execFileSync(process.execPath, [join(KIT, 'tools', 'render.mjs'), 'icon/gear', 'floor/plank', '--out', dir, '--name', 'sample', '--zoom', '4']);
    const file = join(dir, 'sample.png');
    assert.ok(existsSync(file));
    const sheet = fromPNG(readFileSync(file));
    assert.ok(sheet.w >= 16 * 4 + 16 * 4 * 4 && sheet.h >= 16 * 3 * 4, `${sheet.w} x ${sheet.h}`);
    assert.equal(K.emptyPixels(sheet), 0, 'a sheet has a backdrop everywhere');
    assert.match(execFileSync(process.execPath, [join(KIT, 'tools', 'render.mjs'), '--list'], { encoding: 'utf8' }), /char\s+char\/sky/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tools: a contact sheet enlarges each item by its zoom and labels it', () => {
  const sheet = contactSheet([{ label: 'A', canvas: new Canvas(4, 4, RED), zoom: 5 }, { label: 'B', canvas: new Canvas(4, 4), zoom: 2 }], { title: 'T' });
  assert.equal(sheet.data.filter((c) => c === RED).length, 4 * 4 * 25);
  assert.equal(textWidth('AB'), 7);
  assert.equal(frames(new Canvas(32, 64), 16, 32).length, 4);
});

test('the final contact sheets are in pixelkit/records', () => {
  for (const name of ['char', 'tile', 'ui', 'dock-street']) {
    const sheet = loadPNG(join(KIT, 'records', `${name}.png`));
    assert.ok(sheet.w > 400 && sheet.h > 300, name);
  }
});

// ── what the app loads: assets/pixel/town, written by pixelkit/tools/export-app.mjs ──
const TOWN = join(ROOT, 'assets', 'pixel', 'town');

test('export: twelve characters, each with a base sheet and three action sheets, at the sizes the app expects', () => {
  const files = new Map(appFiles().map((f) => [f.name, f.canvas]));
  assert.equal(APP_CHARS.length, 12);
  assert.equal(files.size, 12 * 4 + 9);   // + street_lights: only what the night switches on
  const classic = loadPNG(join(ROOT, 'assets', 'pixel', 'char_0.png'));
  for (let i = 0; i < 12; i++) {
    const size = (n) => [files.get(n).w, files.get(n).h];
    assert.deepEqual(size(`char_${i}`), [classic.w, classic.h], `char_${i} matches the classic sheet`);
    assert.deepEqual(size(`char_${i}`), [112, 96]);
    assert.deepEqual(size(`char_${i}_umbrella`), [32, 96]);
    assert.deepEqual(size(`char_${i}_jump`), [64, 96]);
    assert.deepEqual(size(`char_${i}_carry`), [32, 96]);
    for (const n of ['', '_umbrella', '_jump', '_carry']) assert.equal(K.clipped(files.get(`char_${i}${n}`), { frame: [16, 32] }).length, 0, `char_${i}${n} fits its frames`);
  }
  // the list of files the office swaps in still names the twelve
  const names = JSON.parse(readFileSync(join(TOWN, 'names.json'), 'utf8'));
  for (let i = 0; i < 12; i++) assert.ok(names.includes(`char_${i}`), `names.json has char_${i}`);
});

test('export: the twelve are told apart at the dock\'s size, and an umbrella stays inside its 16 x 28 window', () => {
  // the dock shows the facing-down row through a window that cuts the top 4 px off
  const windowOf = (name, pose) => C.frame(C.PRESETS[name], 'down', pose).crop(0, 4, 16, 28);
  const looks = new Set(APP_CHARS.map((n) => windowOf(n, 'walkA').data.join()));
  assert.equal(looks.size, 12, 'no two look the same');
  const pairs = new Set(APP_CHARS.map((n) => { const c = C.character(C.PRESETS[n]); return `${c.hat ? c.hat.color : c.hair.color} ${c.top.color}`; }));
  assert.equal(pairs.size, 12, 'no two share what is on the head and the color of the top');
  const tops = APP_CHARS.map((n) => C.character(C.PRESETS[n]).top.color);
  assert.equal(new Set(tops).size, 12, 'every top is its own color');
  for (const n of APP_CHARS) {
    const face = windowOf(n, 'walkA');
    assert.ok(face.get(5, 12) === INK && face.get(10, 12) === INK, `${n}: both eyes are in the window`);
    for (const view of C.VIEWS) for (const pose of C.ACTIONS.umbrella) {
      const f = C.frame(C.PRESETS[n], view, pose);
      assert.equal(f.crop(0, 0, 16, 4).colors().size, 0, `${n} ${view} ${pose}: nothing above the window`);
      assert.equal(K.clipped(f).length, 0);
    }
  }
});

test('export: the street\'s skies and front repeat left to right', () => {
  for (const kind of ['day', 'dusk', 'night']) {
    const s = T.streetSky(kind);
    assert.deepEqual([s.w, s.h], [64, 72], kind);
    assert.equal(K.emptyPixels(s), 0, kind);
    assert.ok(T.seamReport(s, { y: false }).ok, kind);
    for (let y = 0; y < 72; y++) if (kind !== 'night') assert.equal(s.get(0, y), s.get(4, y), `${kind}: the dither repeats every 4 px, so 64 px wraps`);
  }
  assert.throws(() => T.streetSky('noon'), /unknown street sky/);
  for (const lit of [false, true]) {
    const f = T.street({ lit });
    assert.deepEqual([f.w, f.h], [512, 72]);
    assert.ok(T.seamReport(f, { y: false }).ok, JSON.stringify(T.seamReport(f, { y: false })));
    // the two ends are open sky above the pavement, so no wall is cut by the wrap
    for (const x of [0, 1, 510, 511]) for (let y = 0; y < 40; y++) assert.equal(f.get(x, y), 0, `x ${x} y ${y}`);
    // the top is see-through between and above the buildings; from the pavement down it is solid
    assert.ok(K.emptyPixels(f.crop(0, 0, 512, 40)) > 1500);
    assert.equal(K.emptyPixels(f.crop(0, 40, 512, 32)), 0);
    assert.equal(K.softPixels(f), 0);
    // the pavement where characters and name tags go is pale, and its pattern repeats every 32 px
    for (let x = 0; x < 512; x += 7) for (let y = 44; y < 66; y++) assert.ok(lumaOf(f.get(x, y)) > 0.8, `pavement at ${x}, ${y}`);
    if (!lit) for (let y = 40; y < 72; y++) for (let x = 0; x < 480; x++) assert.equal(f.get(x, y), f.get(x + 32, y));
  }
  // buildings are not all one height: the highest drawn pixel varies along the strip
  const day = T.street(), heights = new Set();
  for (let x = 0; x < 512; x++) { let y = 0; while (y < 40 && !day.get(x, y)) y++; heights.add(y); }
  assert.ok(heights.size >= 8 && heights.has(40) && heights.has(0), [...heights].join());
});
const lumaOf = (c) => (0.299 * (c & 255) + 0.587 * ((c >>> 8) & 255) + 0.114 * ((c >>> 16) & 255)) / 255;

test('export: the lit street is the day street with only its lights changed', () => {
  const day = T.street(), lit = T.street({ lit: true });
  const inLight = (x, y) => T.LIT_REGIONS.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);
  let changed = 0, glow = 0;
  for (let y = 0; y < 72; y++)
    for (let x = 0; x < 512; x++) {
      if (day.get(x, y) === lit.get(x, y)) continue;
      changed++;
      assert.ok(inLight(x, y), `${x}, ${y} differs outside a window, a lamp or its light on the pavement`);
      assert.ok(day.get(x, y) && lit.get(x, y), 'a light never adds or removes a pixel: the silhouette is the same');
      glow += lumaOf(lit.get(x, y)) - lumaOf(day.get(x, y));
    }
  assert.ok(glow / changed > 0.03, 'on the whole the changed pixels get brighter');
  assert.ok(changed > 2500, `${changed} pixels light up`);
  assert.ok(T.LIT_REGIONS.length >= 20);
  assert.ok(T.LIT_REGIONS.every(([x, y, w, h]) => x >= 0 && y >= 0 && x + w <= 512 && y + h <= 46), 'lights stay off the part where characters stand');
});

test('export: the lamp is one lamp in two states, and a cloud', () => {
  const off = T.streetLamp(), on = T.streetLamp({ lit: true });
  assert.deepEqual([off.w, off.h], [on.w, on.h]);
  const rows = []; for (let y = 0; y < off.h; y++) if (off.crop(0, y, off.w, 1).colors().size) rows.push(y);
  assert.ok(rows.length >= 32 && rows.length <= 36, `the lamp is ${rows.length} px tall`);
  assert.equal(rows.at(-1), off.h - 1, 'its foot is on the bottom row');
  assert.equal(K.softPixels(off), 0);
  assert.ok(K.softPixels(on) > 40, 'lit, it has a halo');
  let moved = 0;
  for (let i = 0; i < off.data.length; i++) { if (off.data[i]) assert.ok(on.data[i] >>> 24 === 255, 'every pixel of the lamp is still there'); if (off.data[i] !== on.data[i] && off.data[i]) moved++; }
  assert.ok(moved >= 12 && moved <= 30, `only the glass changes (${moved} px)`);
  const c = T.streetCloud();
  assert.ok(c.w >= 24 && c.h >= 10 && K.emptyPixels(c) > 0 && K.softPixels(c) === 0);
});

test('export: the files on disk are what the code draws, and drawing again gives the same bytes', () => {
  const a = appFiles(), b = appFiles();
  for (const [i, f] of a.entries()) {
    assert.ok(f.canvas.equals(b[i].canvas), `${f.name} draws the same twice`);
    const file = join(TOWN, `${f.name}.png`);
    assert.ok(existsSync(file), `${f.name}.png exists`);
    assert.ok(readFileSync(file).equals(toPNG(f.canvas)), `${f.name}.png is stale: run node pixelkit/tools/export-app.mjs`);
  }
  assert.equal(spawnSync(process.execPath, [join(KIT, 'tools', 'export-app.mjs'), '--check']).status, 0);
  const dir = mkdtempSync(join(tmpdir(), 'pixelkit-export-'));
  try {
    execFileSync(process.execPath, [join(KIT, 'tools', 'export-app.mjs'), '--out', dir]);
    assert.equal(readdirSync(dir).length, a.length);
    for (const f of a) assert.ok(readFileSync(join(dir, `${f.name}.png`)).equals(readFileSync(join(TOWN, `${f.name}.png`))), f.name);
    assert.equal(spawnSync(process.execPath, [join(KIT, 'tools', 'export-app.mjs'), '--check', '--out', dir]).status, 0);
    rmSync(join(dir, 'street_cloud.png'));
    assert.equal(spawnSync(process.execPath, [join(KIT, 'tools', 'export-app.mjs'), '--check', '--out', dir]).status, 1, 'a missing file is reported');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
