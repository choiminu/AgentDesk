// widget.html skillbook page (source checks, like office-fx.test.mjs): nav + page + size + loader, the agent filter, the
// four tabs, the 📊 사용 기록 periods and bulk buttons, and that every remove reaches skillbookAct only through the
// in-page confirm row (never window.confirm). Also runs the I18N check so every new Korean string has an English entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
// the page's script: from its section header to its end marker
const start = html.indexOf('// SKILLBOOK PAGE');
const end = html.indexOf('// ── end of SKILLBOOK PAGE', start);
const sb = start < 0 || end < 0 ? '' : html.slice(start, end);

test('skillbook ui: nav button, page, size and loader', () => {
  assert.match(html, /data-page="jira">Jira<span[^\n]*<\/button>\n\s*<button class="page-nav-btn" data-page="skillbook">스킬북<\/button>/);
  assert.match(html, /<div class="page" id="page-skillbook">/);
  assert.match(html, /skillbook:\s*\{ w: 640, h: 560 \}/);
  assert.match(html, /if \(currentPage === 'skillbook'\) skillbookLoad\(\);/);
  assert.ok(sb.length > 1000, 'skillbook script section exists');
  assert.match(sb, /async function skillbookLoad\(/);
  assert.match(sb, /function skillbookRender\(/);
  assert.match(sb, /let sbState = \{ agent: 'all', tab: 'skill', period: 30, picked: new Set\(\), sel: null, data: null/);
});

test('skillbook ui: agent filter and tabs', () => {
  assert.match(sb, /\['all', '전체'\], \['claude', 'Claude'\], \['codex', 'Codex'\], \['gemini', 'Gemini'\]/);
  assert.match(sb, /\['skill', '스킬'\], \['plugin', '플러그인'\], \['mcp', '🧰 도구 주머니'\], \['usage', '📊 사용 기록'\]/);
  for (const s of ['미사용', '사용 기록 없음', '이번 주', '하는 일', '이렇게 말하면 켜짐', '출처', '쓸 수 있는 에이전트', '폴더 열기', '최근 제거', '되살리기', '아직 설치된 것이 없습니다'])
    assert.ok(sb.includes(`'${s}'`), `copy: ${s}`);
  assert.match(sb, /action: 'reveal'|'reveal'/);
});

test('skillbook ui: 📊 사용 기록 tab with the three periods, gauge and bulk buttons', () => {
  assert.match(sb, /\[7, '7일'\], \[30, '30일'\], \[0, '전체'\]/);
  for (const s of ['💤 안 쓰는 것', '고른 것 끄기', '휴지통으로', 'Codex·Gemini 전용 항목은 사용 기록을 셀 수 없어 빠졌습니다'])
    assert.ok(sb.includes(`'${s}'`), `copy: ${s}`);
  assert.match(sb, /Math\.round\(10 \* n \/ max\)/);
});

test('skillbook ui: backfill line and polling while the page is open', () => {
  assert.ok(sb.includes("'사용 기록을 읽는 중…'"));
  assert.match(sb, /backfill === 'running'/);
  assert.match(sb, /setTimeout\([^;]*currentPage === 'skillbook'[^;]*skillbookLoad\(\)[^;]*4000\)/);
});

test('skillbook ui: remove goes through the in-page confirm, never window.confirm', () => {
  assert.doesNotMatch(sb, /(?:^|[^\w.])confirm\(/m, 'no window.confirm');
  // one place calls the IPC
  assert.equal((sb.match(/window\.orca\.skillbookAct\(/g) || []).length, 1);
  // every 'remove' run is started from sbConfirm's callback
  const runs = sb.split('\n').filter(l => /sbRun\([^)]*'remove'/.test(l));
  assert.ok(runs.length >= 2, 'single and bulk remove');
  for (const l of runs) assert.match(l, /sbConfirm\(/, `remove without confirm: ${l.trim()}`);
  // the bulk: one confirm, then the items one by one, then one summary toast
  assert.match(sb, /for \(const id of ids\) \{[^}]*await sbAct\(id, action\)/);
  assert.equal((sb.match(/showInAppToast\(/g) || []).length, 1, 'one summary toast');
});

test('skillbook ui: user text goes through esc() and stays verbatim', () => {
  assert.doesNotMatch(sb, /\$\{\s*(?:it|x|r)\.(?:name|description|repo|source|path)\b/);
  assert.match(sb, /data-verbatim>\$\{esc\(it\.name\)\}/);
});

test('skillbook ui: every Korean string has an English entry', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/i18n-check.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
