// widget.html 🏪 상점 tab (source checks): tab, filters and sorts, password fields for needs, install only through the
// in-page confirm, the link box, and that no env value reaches innerHTML, a toast or the console. Plus the I18N check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
const a = html.indexOf('// ── 🏪 상점 tab'), b = html.indexOf('// ── end of SHOP TAB', a);
const shop = a < 0 || b < 0 ? '' : html.slice(a, b);
const fn = name => { const i = shop.indexOf(name); const j = shop.indexOf('\nfunction ', i + 1); const k = shop.indexOf('\nasync function ', i + 1); return shop.slice(i, Math.min(...[j, k, shop.length].filter(x => x > i))); };

test('shop ui: tab, filters, sorts, state object', () => {
  assert.ok(shop.length > 2000, 'shop section exists');
  assert.match(html, /\['shop', '🏪 상점'\]\];/);
  assert.match(shop, /const shopState = \{/);
  assert.match(shop, /\['all', '전체'\], \['plugin', '플러그인'\], \['mcp', 'MCP'\], \['skill', '스킬'\]/);
  assert.match(shop, /\['new', '새로 나온 순'\], \['pop', '인기순'\], \['name', '이름순'\]/);
  assert.match(html, /if \(sbState\.tab === 'shop'\) \[left, right\] = shopPages\(\);/);
  for (const s of ['불러오는 중…', '사용할 수 없는 출처', '설치하면', '설치 후 Claude에서 인증이 필요합니다', '실행 파일 포함', '자동 설치 불가', '모든 에이전트', '새 버전 있음', '설치됨'])
    assert.ok(shop.includes(`'${s}'`) || html.includes(`'${s}'`), s);
  assert.ok(shop.includes('플러그인은 Claude Code 안에서 훅·스크립트를 실행할 수 있습니다 — 출처를 확인하세요'));
});

test('shop ui: env fields are passwords, read at submit and cleared; no value reaches innerHTML, toast or console', () => {
  assert.match(shop, /type="password"[^>]*data-shop-env/);
  assert.match(shop, /el\.value = ''/);
  const run = fn('async function shopInstallRun');
  assert.match(run, /window\.orca\.shopInstall\(req\)/);
  assert.match(run, /shopClearEnv\(\);[\s\S]*await window\.orca\.shopInstall/, 'cleared before the call too');
  assert.match(run, /try \{ r = await window\.orca\.shopInstall\(req\); \} catch \{\}\s*env = null; req\.env = null;\s*shopClearEnv\(\);/, 'cleared after, also on failure');
  assert.doesNotMatch(shop, /console\./);
  assert.doesNotMatch(shop, /\.value\s*\)?\s*[`+][^\n]*innerHTML|innerHTML[^\n]*\.value/);
  assert.doesNotMatch(shop, /showInAppToast\([^\n]*\benv\b/);
  assert.doesNotMatch(shop, /shopState\.env|shopState\[.env/);
  assert.doesNotMatch(shop, /value="\$\{[^}]*env/);
});

test('shop ui: install goes through the in-page confirm; update is display-only; link box', () => {
  assert.match(fn('function shopInstallAsk'), /sbState\.ask = \{[^}]*run: \(\) => shopInstallRun\(/);
  assert.equal((shop.match(/window\.orca\.shopInstall\(/g) || []).length, 1);
  assert.doesNotMatch(shop, /window\.confirm|confirm\(/);
  assert.doesNotMatch(shop, /data-sb="shop-update"|업데이트 하기/);
  assert.match(shop, /window\.orca\.shopLink\(\{ text \}\)/);
  assert.match(shop, /🔗 링크로 설치/);
  assert.match(shop, /window\.orca\.shopList\(/);
  assert.match(shop, /await Promise\.all\(\[skillbookLoad\(\), shopLoad\(false\)\]\)/);
  assert.match(shop, /설치했습니다 \(로컬 마켓 경로\)/);
  for (const d of ['conflict', 'exists', 'needs', 'missing', 'bad link', 'clone', 'empty']) assert.ok(shop.includes(d), d);
  assert.match(shop, /p\.detail === 'conflict'/);
});

test('shop ui: poll redraws only the bar on the shop tab; link errors translated at render; view-in-skillbook; picker', () => {
  assert.match(html, /if \(sbBarOnly\) return;/);
  assert.match(html, /sbBarOnly = sbState\.tab === 'shop' && !shopState\.loading;\s*try \{ skillbookRender\(\); \} finally \{ sbBarOnly = false; \}/);
  assert.match(shop, /l\.errR = /);
  assert.match(shop, /링크를 다시 찾으세요/);
  assert.match(shop, /data-sb="shop-view"/);
  assert.match(shop, /if \(r\.found\.length === 1\) shopState\.sel = /);
  assert.match(shop, /\[가-힣\]\/\.test\(s\)/);
  assert.match(shop, /it\.plan && it\.plan\.kind === 'installed'/);
});

test('shop ui: SHOP_ERR details are exactly payload.mjs DETAILS the user can see', () => {
  const pay = readFileSync(new URL('../shop/payload.mjs', import.meta.url), 'utf8');
  const details = [...pay.match(/const DETAILS = new Set\(\[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const errBlock = shop.slice(shop.indexOf('const SHOP_ERR = {'), shop.indexOf('const SHOP_ERR_TOP'));
  const mapped = d => errBlock.includes(`'${d}':`) || new RegExp(`[{,\\s]${d}:`).test(errBlock);
  for (const d of ['conflict', 'exists', 'needs', 'missing', 'bad link', 'clone', 'empty', 'io', 'invalid JSON', 'manual', 'cli']) assert.ok(details.includes(d) && mapped(d), d);
  for (const d of details) if (!['bad request', 'unparsed', 'kind'].includes(d)) assert.ok(mapped(d), 'unmapped detail ' + d);
});

test('shop ui: i18n check passes', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/i18n-check.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('an installed item shows 스킬북에서 보기 instead of the install button', () => {
  const src = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
  assert.match(src, /const btn = done \? view : !manual \? /);
});

test('shop ui: install-result missing names the file; gone keeps reload / find-again; registry note', () => {
  const errs = shop.slice(shop.indexOf('const SHOP_ERR = {'), shop.indexOf('const shopCmdLine'));
  const shopErrText = new Function('t', errs.replace(/const /g, 'var ') + '; return shopErrText;')(s => s);
  assert.equal(shopErrText({ ok: false, error: 'failed', detail: 'missing' }), '필요한 파일을 찾지 못했습니다 (~/.claude.json 또는 SKILL.md)');
  assert.equal(shopErrText({ ok: false, error: 'failed', detail: 'missing' }, true), '필요한 파일을 찾지 못했습니다 (~/.claude.json 또는 SKILL.md)');
  assert.equal(shopErrText({ ok: false, error: 'gone', detail: 'missing' }), '목록을 다시 불러오세요');
  assert.equal(shopErrText({ ok: false, error: 'gone', detail: 'missing' }, true), '링크를 다시 찾으세요');
  assert.equal(shopErrText({ ok: false, error: 'failed', detail: 'clone' }), '저장소를 가져오지 못했습니다');
  assert.match(fn('function shopPages'), /s\.id === 'registry' && s\.ok\) \? `<div class="sb-hint">\$\{esc\(t\('MCP 레지스트리는 최신 500개까지만 보입니다/);
});
