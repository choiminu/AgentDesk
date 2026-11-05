// "[스킬명] 스킬 사용": a live Skill tool call (or a /name prompt for an installed skill) plays the skill-cast effect at that
// session's office character and dock tile, with a short label. Source checks, like test/office-fx.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
const FX = JSON.parse(html.match(/^const OFFICE_FX = (\{.*\});$/m)[1]);
const pngSize = file => { const b = readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const fn = name => { const i = html.indexOf(`function ${name}(`); assert.ok(i >= 0, `${name} exists`); return html.slice(i, html.indexOf('\n}\n', i) + 2); };

test('skill cast: a small one-shot sheet in the OFFICE_FX table', () => {
  const f = FX.skillCast;
  assert.ok(f, 'skillCast in OFFICE_FX');
  assert.equal(f.src, 'fx/skill-cast');
  assert.equal(f.loop, false);
  assert.deepEqual([f.w, f.h], [48, 56]);
  assert.deepEqual(pngSize(new URL(`../assets/pixel/${f.src}.png`, import.meta.url)), [f.cols * f.w, Math.ceil(f.n / f.cols) * f.h]);
  assert.ok(f.n / f.fps <= 1.5, 'quick: at most 1.5 s');
  assert.match(readFileSync(new URL('../scripts/office-fx.mjs', import.meta.url), 'utf8'), /key: "skillCast", id: "office\/skill-cast"/);
  assert.match(readFileSync(new URL('../assets/pixel/CREDITS.md', import.meta.url), 'utf8'), /skill-cast/);
});

test('skill cast: Skill PreToolUse and /name prompts of installed skills are detected', () => {
  const of = fn('skillCastOf');
  assert.match(of, /hook_event_name === 'PreToolUse' && ev\.tool_name === 'Skill'/);
  assert.match(of, /tool_input\.skill/);
  assert.match(of, /hook_event_name === 'UserPromptSubmit'/);
  assert.match(of, /<command-name>/);
  // a prompt counts only when it names an installed skill (not /clear, /compact or a path)
  assert.match(fn('skillCastFrom'), /await skillCastInstalled\(/);
  assert.match(fn('skillCastInstalled'), /window\.orca\.skillbook\(\)/);
});

test('skill cast: only live records trigger it, never the replay', () => {
  assert.match(html, /window\.orca\.onHookEvents\(evts => \{\n\s+for \(const rec of evts\) \{ applyHookEvent\(rec\); skillCastFrom\(rec\); \}/);
  for (const m of html.matchAll(/for \(const rec of await window\.orca\.hooksRecent\(\)\)[^\n]*/g)) assert.doesNotMatch(m[0], /skillCast/);
  // main's first read of the events file can push the whole file as "new": old records are skipped
  assert.match(fn('skillCastFrom'), /Date\.now\(\) - rec\.ts \* 1000 > SKILL_CAST_LIVE_MS/);
});

test('skill cast: same session and skill at most once per 10 s', () => {
  assert.match(html, /const SKILL_CAST_GAP_MS = 10000;/);
  const f = fn('skillCastFrom');
  assert.match(f, /skillCastLast\.get\(k\)/);
  assert.match(f, /< SKILL_CAST_GAP_MS\) return;/);
});

test('skill cast: label text is translated and the name is shortened', () => {
  assert.match(html, /'스킬 사용': 'skill'/);
  const lab = fn('skillCastLabel');
  assert.match(lab, /t\('스킬 사용'\)/);
  assert.match(lab, /split\(':'\)\.pop\(\)/);
  assert.match(lab, /16/);
});

test('skill cast: office plays the effect and draws the label with the office font', () => {
  const play = fn('skillCastPlay');
  assert.match(play, /officeFxPlay\('skillCast', \.\.\.officeFeet\(ch\), ch\)/);
  const draw = fn('officeDrawSkillTags');
  assert.match(draw, /ctx\.font = `\$\{officeFontPx\}px \$\{OFFICE_FONT\}`/);
  assert.match(html, /officeDrawFx\(ctx\);\n\s+officeDrawSkillTags\(ctx\);/);
  assert.match(html, /\|\| officeFx\.length > 0 \|\| officeSkillTags\.length > 0 \|\|/);
});

test('skill cast: dock plays it on the tile behind the animation setting, and shows a short info pill', () => {
  const play = fn('skillCastPlay');
  assert.match(play, /if \(dockFxAllowed\(\)\) \{ dockFxPlay\(`me:\$\{s\.id\}`, 'skillCast'\); dockFxSync\(\); \}/);
  assert.match(play, /dockSkillHint\(/);
  const hint = fn('dockSkillHint');
  assert.match(hint, /dock-msg info/);
  assert.doesNotMatch(hint, /dockHideSet|focus\(/);   // never brings the bar back or takes focus
  assert.match(hint, /classList\.contains\('err'\)/);   // an error on the pill stays
  assert.match(html, /\.dock-msg\.info \{/);
});

test('skill cast: the dock tile itself shows who cast it (glow and a name tag), kept across tile redraws', () => {
  const play = fn('skillCastPlay');
  assert.match(play, /dockCastMark\(`me:\$\{s\.id\}`, /);   // outside the animation gate: the tag is information
  const sync = fn('dockCastSync');
  assert.match(sync, /classList\.toggle\('cast'/);
  assert.match(sync, /dock-cast-tag/);
  assert.match(sync, /textContent/);   // the name as text, never HTML
  assert.match(html, /const DOCK_CAST_MS = 2500;/);
  assert.match(fn('dockFxSync'), /^function dockFxSync\(changes\) \{\n  dockCastSync\(\);/);   // before the animation gate
  assert.match(html, /\.dock-tile\.cast \{/);
  assert.match(html, /\.dock-tile\.cast \.dock-spr \{ opacity: 1;/);   // a resting agent lights up while casting
  assert.match(html, /\.dock-tiles\.s40 \.dock-cast-tag \{ display: none; \}/);
  assert.match(html, /prefers-reduced-motion: no-preference\) \{[^}]*\.dock-tiles\.fx \.dock-tile\.cast \{ animation: dockCast/);
});
