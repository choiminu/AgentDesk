// The dock street (core/street.js): sky by the clock, weather by the plan limit, one frame painted from a scene.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
await import('../core/street.js');
const S = globalThis.AgentDeskStreet;
const recorder = () => { const calls = []; return { calls, fillStyle: '', fillRect(x, y, w, h) { calls.push([this.fillStyle, x, y, w, h]); } }; };

test('skyAt / darkAt / lampOn: day, dusk and night', () => {
  assert.deepEqual(S.skyAt(12), ['#4aa6ea', '#a9dcf6']);
  assert.deepEqual(S.skyAt(0), S.skyAt(24), 'midnight is one colour from both sides');
  assert.deepEqual(S.skyAt(36), S.skyAt(12), 'hours wrap');
  assert.equal(S.darkAt(12), 0); assert.equal(S.darkAt(23), 1); assert.equal(S.darkAt(2), 1);
  assert.ok(S.darkAt(18.5) > 0 && S.darkAt(18.5) < 1, 'dusk is in between');
  assert.equal(S.lampOn(17.9), false); assert.equal(S.lampOn(18), true); assert.equal(S.lampOn(6.4), true); assert.equal(S.lampOn(6.5), false);
});
test('weatherOf: clear under 60, cloudy from 60, rain from 80, storm from 95', () => {
  assert.equal(S.weatherOf(0).stage, 'clear'); assert.equal(S.weatherOf(59).stage, 'clear');
  assert.equal(S.weatherOf(60).stage, 'cloudy'); assert.equal(S.weatherOf(79).rain, 0);
  assert.equal(S.weatherOf(80).stage, 'rain'); assert.ok(S.weatherOf(80).rain > 0);
  assert.equal(S.weatherOf(95).stage, 'storm'); assert.equal(S.weatherOf(250).rain, 1, 'clamped');
  for (const v of [null, undefined, '', 'x', NaN]) assert.equal(S.weatherOf(v).stage, 'clear', 'no number: clear');
  assert.equal(S.usagePct([{ pct: 12 }, { pct: 83 }, {}]), 83, 'the fuller window counts');
  assert.equal(S.usagePct([]), null); assert.equal(S.usagePct(null), null);
});
test('layout: the same street for the same width, inside the bar', () => {
  assert.deepEqual(S.layout(300, 7), S.layout(300, 7));
  const l = S.layout(300, 7);
  assert.ok(l.buildings.length > 5 && l.stars.every(s => s.x >= 0 && s.x < 300));
  assert.equal(S.layout(0, 7).stars.length, 0);
});
test('paint: draws inside the canvas; rain only when it rains and motion is allowed; lamps by night', () => {
  const scene = o => ({ w: 300, h: 36, hour: 12, pct: 10, tick: 3, lay: S.layout(300, 7), heads: [{ x: 40, y: 10 }], lamps: [20, 80], dimFrom: 240, ...o });
  let g = recorder(), r = S.paint(g, scene());
  assert.equal(r.stage, 'clear'); assert.equal(r.lit, false); assert.equal(r.drops, 0); assert.equal(r.moving, false);
  assert.ok(g.calls.length > 50);
  assert.ok(g.calls.every(c => typeof c[0] === 'string' && c.slice(1).every(Number.isFinite)), 'every rect has a colour and numbers');
  g = recorder(); r = S.paint(g, scene({ pct: 90, hour: 22 }));
  assert.equal(r.stage, 'rain'); assert.equal(r.lit, true); assert.ok(r.drops > 0); assert.equal(r.moving, true);
  assert.ok(g.calls.some(c => c[0] === '#d9534f'), 'an umbrella over the first character');
  g = recorder(); r = S.paint(g, scene({ pct: 99, still: true, tick: 0 }));
  assert.equal(r.drops, 0, 'still: no falling rain'); assert.equal(r.flash, false, 'still: no lightning'); assert.equal(r.moving, false);
  assert.ok(g.calls.some(c => c[0] === '#d9534f'), 'the umbrella stays');
  assert.equal(S.paint(recorder(), scene({ pct: 99, tick: 97 })).flash, true);
  assert.equal(S.paint(null, scene()), null); assert.equal(S.paint(recorder(), { w: 0, h: 36 }), null);
  assert.doesNotThrow(() => S.paint(recorder(), { w: 50, h: 20, hour: 'x', pct: {}, heads: [null, {}], lamps: ['a', -5, 9999] }));
});
test('widget: the street is off unless turned on, follows the animation setting and stops off the dock', () => {
  const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="core\/street\.js"><\/script>/);
  assert.match(html, /dockCfg\.street = c\.street === true;/);
  assert.match(html, /still: !dockAnimAllowed\(\)/);
  assert.match(html, /dockOn = false; dockStreetStop\(\);/);
  assert.match(html, /<canvas class="dock-street" id="dock-street" aria-hidden="true" hidden><\/canvas>/);
});
