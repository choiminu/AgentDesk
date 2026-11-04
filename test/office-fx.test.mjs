// widget.html OFFICE_FX ↔ assets/pixel/fx/*.png: the table scripts/office-fx.mjs prints must match the baked sheets,
// or the office draws the wrong cells (or nothing). Also pins the hooks that play them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
const FX = JSON.parse(html.match(/^const OFFICE_FX = (\{.*\});$/m)[1]);
const pngSize = file => { const b = readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('office fx: every sheet exists and its size matches the table', () => {
  assert.deepEqual(Object.keys(FX).sort(), ['blinkIn', 'blinkOut', 'collect', 'exclaim', 'rackA', 'rackB', 'skyDay', 'skyDusk', 'skyNight', 'sleep', 'steam']);
  for (const [key, f] of Object.entries(FX)) {
    const file = new URL(`../assets/pixel/${f.src}.png`, import.meta.url);
    assert.ok(existsSync(file), `${key}: ${f.src}.png missing`);
    assert.deepEqual(pngSize(file), [f.cols * f.w, Math.ceil(f.n / f.cols) * f.h], `${key}: sheet size`);
    assert.ok(f.px >= 0 && f.px <= f.w && f.py >= 0 && f.py <= f.h, `${key}: pivot inside the frame`);
  }
  for (const k of ['sleep', 'steam', 'rackA', 'rackB', 'skyDay', 'skyDusk', 'skyNight']) assert.equal(FX[k].loop, true, `${k} loops`);
  for (const k of ['collect', 'blinkIn', 'blinkOut', 'exclaim']) assert.equal(FX[k].loop, false, `${k} is a one-shot`);
});

test('office fx: wired to finish, question, arrival, departure, rest and error', () => {
  assert.match(html, /officeBeep\('done'\); officeFxPlay\('collect'/);
  assert.match(html, /officeBeep\('ask'\); officeFxPlay\('exclaim', \.\.\.officeFeet\(ch\), ch\)/);
  assert.match(html, /if \(now - officeStartedAt > 1500\) officeFxPlay\('blinkIn'/);
  assert.match(html, /officeFxPlay\('blinkOut'/);
  assert.match(html, /officeDrawSleep\(ctx, ch\.sid/);
  assert.match(html, /st === 'error' && ch\.alpha >= 1\) officeDrawGlitch\(/);
  // one-shots raise the frame rate while they play; the sleep loop does not (it reads fine at 10 fps)
  assert.match(html, /\|\| officeFx\.length > 0 \|\|/);
  assert.doesNotMatch(html, /officeBurst|officeParticles|drawBubble\(ctx, [^;]*'zz'\)/);
});

test('office fx: ambient loops on the windows, coffee cups and rack cabinets', () => {
  assert.match(html, /officeFxDraw\(ctx, night \? 'skyNight' : dusk \? 'skyDusk' : 'skyDay'/);
  assert.match(html, /officeFxDraw\(ctx, 'steam'/);
  assert.match(html, /officeFxDraw\(ctx, key === 'k_rack_a' \? 'rackA' : 'rackB'/);
});

test('dock fx: finish sparkle, arrival blink, zzz and the error glitch, all behind the dock animation setting', () => {
  assert.match(html, /const dockFxAllowed = \(\) => dockAnimAllowed\(\);/);
  assert.match(html, /c\.from === 'run' && \(c\.to === 'input' \|\| c\.to === 'done'\)\) dockFxPlay\(c\.key, 'collect'\)/);
  assert.match(html, /if \(dockFxPrimed\) dockFxPlay\(k, 'blinkIn'\)/);
  // a redraw of the tiles (a minute label, a new tile) puts a one-shot back where it was, not from the start
  assert.match(html, /if \(!b\.querySelector\(`\.dock-fx\[data-t0="\$\{e\.t0\}"\]`\)\) dockFxEl\(b, e\.kind, false, e\.t0\)/);   // not for the tiles already there on the first draw
  assert.match(html, /dockFxEl\(b, 'sleep', true\)/);
  assert.match(html, /\.dock-tiles\.fx \.dock-tile\.st-err \.dock-spr \{ animation: dockGlitch/);
  assert.match(html, /prefers-reduced-motion: no-preference\) \{\n\s+\.dock-tiles\.fx/);
  assert.match(html, /dockFxSync\(changes\);/);
});
