// scripts/i18n-check.mjs — widget.html must have no Korean left in English mode (t() keys and untranslated literals).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkWidgetI18n, lexLiterals, loadI18n, makeTr } from '../scripts/i18n-check.mjs';

const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf-8');
const allow = JSON.parse(readFileSync(new URL('../scripts/i18n-allow.json', import.meta.url), 'utf-8'));

test('widget.html: every t() literal has an I18N key and no Korean is left in English mode', () => {
  const r = checkWidgetI18n(html, allow);
  const show = xs => xs.map(x => `widget.html:${x.line} ${x.text.slice(0, 80)}`).join('\n');
  assert.equal(r.missingKeys.length, 0, `t() without an I18N key (run node scripts/i18n-check.mjs):\n${show(r.missingKeys)}`);
  assert.equal(r.untranslated.length, 0, `Korean left in English mode (run node scripts/i18n-check.mjs):\n${show(r.untranslated)}`);
});

test('i18n-allow.json stays small and grouped by reason', () => {
  const n = Object.values(allow.strings || {}).flat().length + Object.values(allow.patterns || {}).flat().length;
  assert.ok(n <= 20, `allowlist has ${n} entries — translate instead of allowing`);
  for (const [reason, list] of Object.entries(allow.strings || {})) assert.ok(reason.length > 10 && Array.isArray(list), reason);
});

test('lexLiterals: strings, template pieces and nested ${} literals; comments and regexes skipped', () => {
  const src = "// '주석'\nconst a = '하나', b = \"둘\"; /* '셋' */ const r = /넷/g; const c = `다섯 ${t('여섯')} 일곱`; x = y / 2 / '여덟';";
  const texts = lexLiterals(src).map(l => l.text).filter(s => /[가-힣]/.test(s));
  assert.deepEqual(texts.sort(), ['하나', '둘', '다섯 ', '여섯', ' 일곱', '여덟'].sort());
});

function check(script, I18N, allowList) {
  const page = `<html><body><script>\nconst I18N = ${JSON.stringify(I18N)};\nconst I18N_KEYS = [];\n${script}\n</script></body></html>`;
  return checkWidgetI18n(page, allowList || {});
}

test('checkWidgetI18n: a missing key, an untranslated literal, a language branch and the allowlist', () => {
  const I18N = { '저장': 'Save', '취소': 'Cancel' };
  let r = check("t('저장'); t('삭제'); el.textContent = '취소'; el.title = '닫기';", I18N);
  assert.deepEqual(r.missingKeys.map(x => x.text), ['삭제']);
  assert.deepEqual(r.untranslated.map(x => x.text), ['닫기']);
  r = check("const m = LANG === 'en' ? 'Close' : '닫기';\nfunction p() {\n  if (LANG === 'en') return `Hi ${x}`;\n  return `안녕 ${x}`;\n}", I18N);
  assert.equal(r.untranslated.length, 0, 'the Korean arm of a language branch is not flagged');
  r = check("const demo = ['매입'];", I18N, { strings: { 'demo fixtures for screenshots': ['매입'] } });
  assert.equal(r.untranslated.length, 0);
});

test('I18N_FR covers every I18N key and translates to non-Korean French', () => {
  const { I18N, I18N_FR } = loadI18n(html);
  assert.ok(I18N_FR, 'I18N_FR map missing from widget.html');
  assert.deepEqual(Object.keys(I18N_FR).sort(), Object.keys(I18N).sort(), 'I18N_FR must cover every I18N key');
  const trFr = makeTr(I18N_FR);
  const bad = Object.keys(I18N).filter(k => /[가-힣]/.test(trFr(k)));
  assert.equal(bad.length, 0, `French translation still Korean: ${bad.slice(0, 5).map(k => `${k} → ${trFr(k)}`).join(' | ')}`);
});

test('checkWidgetI18n: Korean left in French mode (even if English is covered) is flagged', () => {
  const page = `<html><body><script>\nconst I18N = {"저장": "Save"};\nconst I18N_FR = {"저장": "저장"};\nconst I18N_KEYS = [];\nconst I18N_FR_KEYS = [];\nel.textContent = '저장';\n</script></body></html>`;
  const r = checkWidgetI18n(page, {});
  assert.equal(r.untranslated.length, 1, 'a piece untranslated in one non-Korean mode must be flagged');
});

test('makeTr: exact, trimmed, then longest-key substitution (as t() does)', () => {
  const tr = makeTr({ '세션': 'Session', '세션 종료': 'End session' });
  assert.equal(tr('세션 종료'), 'End session');
  assert.equal(tr(' 세션 '), ' Session ');
  assert.equal(tr('세션 종료 · 세션'), 'End session · Session');
});
