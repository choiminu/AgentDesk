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
  // log scale with at least one cell for any use; colour by the period's own count (not the 30-day mastery)
  assert.match(sb, /n \? Math\.max\(1, Math\.ceil\(10 \* Math\.log1p\(n\) \/ Math\.log1p\(max\)\)\) : 0/);
  assert.match(sb, /sb-gauge\$\{n >= 20 \? '' : n >= 5 \? ' mid' : ' low'\}/);
  assert.doesNotMatch(sb, /Math\.round\(10 \* n \/ max\)/);
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
  assert.ok(runs.length >= 1, 'single remove');
  for (const l of runs) assert.match(l, /sbConfirm\(/, `remove without confirm: ${l.trim()}`);
  // the bulk (off and trash alike): one confirm for the batch
  assert.match(sb, /sbConfirm\([^\n]*\(\) => sbRun\(ids, a, skipped\)\)/);
  assert.doesNotMatch(sb, /sbRun\(a === 'off'/);
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

// ---- final fix wave ----
const fn = name => { const i = sb.indexOf(`function ${name}(`); return i < 0 ? '' : sb.slice(i, sb.indexOf('\n}\n', i)); };

test('skillbook ui: a failed poll keeps the data already shown', () => {
  const load = fn('skillbookLoad');
  assert.match(load, /if \(r && r\.ok\) sbState\.data = r;/);
  assert.match(load, /else if \(!sbState\.data \|\| !sbState\.data\.ok\) sbState\.data = \{ ok: false/);
});

test('skillbook ui: while usage is still being read, 💤 has no rows and both bulk buttons are disabled', () => {
  const pages = fn('sbUsagePages');
  assert.match(pages, /const reading = [^;]*backfill === 'running'/);
  assert.match(pages, /const dis = reading \|\| /);
  assert.match(pages, /reading \? `<div class="sb-empty">\$\{esc\(t\('사용 기록을 읽는 중…'\)\)\}<\/div>`/);
  assert.match(sb, /\(k === 'pick' \|\| k === 'bulk'\) && sbReading\(\)/);
});

test('skillbook ui: 📊 one row per kind + usageKey, 💤 only items that are on, each labelled by where it lives', () => {
  const pages = fn('sbUsagePages');
  assert.match(pages, /`\$\{it\.kind\}\\u0000\$\{it\.usageKey \|\| it\.id\}`/);
  assert.match(sb, /×\$\{n\} 곳/);
  assert.match(pages, /it\.on !== false && !sbCount\(it, sbState\.period\)/);
  assert.match(pages, /\$\{sbWhere\(it\)\}/);
  for (const s of ['사용자 설정', '공유 스킬', '확장'])
    assert.ok(sb.includes(`'${s}'`), `copy: ${s}`);
});

test('skillbook ui: detail page shows the split by agent and the MCP tools seen', () => {
  const d = fn('sbDetail');
  assert.match(d, /kv\('에이전트별', /);
  assert.match(d, /u\.byAgent/);
  assert.match(d, /kv\('사용한 도구', \(u\.tools \|\| \[\]\)\.map\(x => `<span class="sb-chip" data-verbatim>\$\{esc\(x\)\}<\/span>`\)/);
});

// ---- dock mode: the 📖 button opens the same book in a panel above the bar ----
const cut = (s, a, b) => { const i = s.indexOf(a); return i < 0 ? '' : s.slice(i, s.indexOf(b, i + a.length)); };

test('skillbook ui (dock): 📖 button next to 📥 with an I18N title and aria-label', () => {
  assert.match(html, /<button class="dock-btn" id="dock-inbox"[^\n]*<\/button>\n\s*<button class="dock-btn" id="dock-sb" aria-haspopup="true" aria-expanded="false">📖<\/button>/);
  assert.match(html, /'도크: 스킬북': 'Skillbook'/);
  assert.match(cut(html, 'function dockLabels()', '\n}\n'), /\['dock-sb', '도크: 스킬북'\]/);
  assert.match(html, /\$\('dock-sb'\)\.addEventListener\('click', e => \{ e\.stopPropagation\(\); sbDockToggle\(\); \}\);/);
});

test('skillbook ui (dock): the panel kind is reserved in dockPopKind and dockBoundsSync', () => {
  assert.match(html, /<div class="inbox-panel sb-dock" id="sb-dock" role="dialog" aria-label="스킬북" hidden>/);
  assert.match(html, /const DOCK_SB_H = 4\d\d, DOCK_SB_W = \d+;/);
  assert.match(cut(html, 'function dockPopKind()', '\n}\n'), /if \(inboxQOpen\) return 'inbox';\n\s*if \(sbDockOpen\) return 'skillbook';/);
  const bs = cut(html, 'function dockBoundsSync(natural)', '\n}\n');
  assert.match(bs, /kind === 'skillbook' \? DOCK_SB_H/);
  assert.match(bs, /popWidth: kind === 'skillbook' \? DOCK_SB_W : /, 'the window grows sideways for the two pages');
  assert.match(bs, /dockFullPop\(kind\) \? \{ x: 8, width: Math\.max\(0, window\.innerWidth - 16\) \}/);
  assert.match(bs, /!dockFullPop\(kind\) && !bubbles \? dockPopGeom\(kind\)/);
  assert.match(html, /const dockFullPop = k => k === 'inbox' \|\| k === 'skillbook';/);
  // placed like the review queue, and the pointer over it keeps the clicks
  assert.match(cut(html, 'function dockPopPlace()', '\n}\n'), /if \(sbDockOpen\) \{[^\n]*\$\('sb-dock'\)/);
  assert.match(html, /closest\('#dock-strip, #inbox-panel, #sb-dock, /);
});

test('skillbook ui (dock): one panel at a time; Esc, the button and leaving the dock close it', () => {
  const tog = cut(html, 'function sbDockToggle(', '\n}\n');
  assert.ok(tog, 'sbDockToggle exists');
  for (const s of ['inboxToggle(false)', 'dockTermClose(true)', 'dockTipHide()', 'dockPopClose()', 'dockUsageHide()', 'dockBoundsSync()', 'skillbookLoad()'])
    assert.ok(tog.includes(s), `sbDockToggle: ${s}`);
  assert.match(tog, /if \(!want \|\| !dockOn\)/, 'only while docked');
  assert.match(cut(html, 'function inboxToggle(', '\n}\n'), /if \(dockOn && sbDockOpen\) sbDockToggle\(false\);/);
  assert.match(cut(html, 'function dockPopOpen(', '\n}\n'), /sbDockToggle\(false\)/);
  assert.match(cut(html, 'function dockLeave(', '\n}\n'), /if \(sbDockOpen\) sbDockToggle\(false\);/);
  assert.match(html, /if \(e\.key === 'Escape'\) \{\n\s*if \(inboxQOpen\) \{ inboxToggle\(false\); return; \}\n\s*if \(sbDockOpen\) \{ sbDockToggle\(false\); \$\('dock-sb'\)\.focus\(\); return; \}/);
  // a click outside (composedPath: a click inside re-renders the book, so the target may be gone from the DOM)
  assert.match(html, /if \(sbDockOpen && !e\.composedPath\(\)\.some\(n => n\.id === 'sb-dock' \|\| n\.id === 'dock-sb'\)\) sbDockToggle\(false\);/);
  // hover cards, the terminal window, bubbles and the limit card yield to it as to the review queue
  assert.match(html, /const dockSheetOpen = \(\) => inboxQOpen \|\| sbDockOpen;/);
  assert.match(cut(html, 'function dockTipShow(', '\n}\n'), /dockSheetOpen\(\) \|\| dockTermBg\(\)/);
  assert.match(cut(html, 'function dockAskPlace()', '\n}\n'), /const show = dockOn && !dockSheetOpen\(\)/);
  assert.match(cut(html, 'function dockUsageShow()', '\n}\n'), /dockSheetOpen\(\)/);
  assert.match(html, /const dockAskVisible = \(\) => dockOn && !dockSheetOpen\(\)/);
  assert.match(html, /const dockDoneVisible = \(\) => dockOn && !dockSheetOpen\(\)/);
  assert.match(html, /if \(!dockOn \|\| !y \|\| dockTyping\(\) \|\| dockSheetOpen\(\)\) return;/, 'hover does not open a terminal window');
});

test('skillbook ui (dock): skillbookRender draws into a container, one copy for the page and the panel', () => {
  assert.match(sb, /function skillbookRender\(root = sbRoot\(\)\) \{\n\s*const bar = root && root\.querySelector\('\.sb-bar'\), book = root && root\.querySelector\('\.sb-book'\);/);
  assert.match(sb, /const sbRoot = \(\) => \$\(sbDockOpen \? 'sb-dock' : 'page-skillbook'\);/);
  assert.equal((html.match(/function skillbookRender\(/g) || []).length, 1);
  assert.equal((html.match(/SB_AGENTS\.map\(/g) || []).length, 1, 'no second copy of the bar');
  assert.match(html, /<div class="page" id="page-skillbook">\n\s*<div class="sb-bar"><\/div>\n\s*<div class="sb-book"><\/div>/);
  assert.match(html, /id="sb-dock"[^>]*>\s*<div class="sb-bar"><\/div>\s*<div class="sb-book"><\/div>\s*<\/div>/);
  // one click handler for both
  assert.match(sb, /function sbClick\(e\) \{/);
  assert.match(sb, /\$\('page-skillbook'\)\.addEventListener\('click', sbClick\);/);
  assert.match(sb, /\$\('sb-dock'\)\.addEventListener\('click', sbClick\);/);
  // compact type in the dock panel
  assert.match(html, /\.sb-dock \.sb-pg \{[^}]*font-size: 11px/);
});

test('skillbook ui (dock): polling while usage is read covers the dock panel', () => {
  const load = fn('skillbookLoad');
  assert.match(load, /if \(currentPage !== 'skillbook' && !sbDockOpen\) return;/);
  assert.match(load, /setTimeout\(\(\) => \(currentPage === 'skillbook' \|\| sbDockOpen\) && skillbookLoad\(\), 4000\)/);
});
