// Skillbook core: core/skillbook.js (SKILL.md, TOML MCP sections, usage records, mastery).
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../core/skillbook.js');
const S = globalThis.AgentDeskSkillbook;

test('parseSkillMd reads front matter', () => {
  assert.deepEqual(
    S.parseSkillMd('---\nname: demo\ndescription: Does X. Use when someone says "do x" or \'run demo\'.\n---\nbody'),
    { name: 'demo', description: 'Does X. Use when someone says "do x" or \'run demo\'.', triggers: ['do x', 'run demo'] });
  assert.deepEqual(S.parseSkillMd('just text'), { name: null, description: '', triggers: [] });
  const b = S.parseSkillMd('---\nname: "blk"\ndescription: >\n  First line\n  second “curly one”.\nother: 1\n---\n');
  assert.equal(b.name, 'blk');
  assert.equal(b.description, 'First line second “curly one”.');
  assert.deepEqual(b.triggers, ['curly one']);
});

test('parseSkillMd caps triggers', () => {
  const many = Array.from({ length: 9 }, (_, i) => `"t${i}"`).join(' ');
  assert.equal(S.parseSkillMd(`---\nname: a\ndescription: ${many} "${'x'.repeat(41)}"\n---`).triggers.length, 6);
  assert.deepEqual(S.parseSkillMd(`---\nname: a\ndescription: "${'x'.repeat(41)}" it's fine\n---`).triggers, []);
});

const TOML = '[mcp_servers.db]\ncommand = "x"\nenv = { K = "v" }\n\n[mcp_servers."remote one"]\nurl = "https://h/p"\n[profile]\na=1\n';

test('toml sections', () => {
  assert.deepEqual(S.tomlMcpServers(TOML), [
    { name: 'db', keys: ['command', 'env'], transport: 'stdio' },
    { name: 'remote one', keys: ['url'], transport: 'http' }]);
  const r = S.tomlRemoveSection(TOML, 'db');
  assert.ok(!r.text.includes('mcp_servers.db'));
  assert.ok(r.text.includes('[profile]') && r.text.includes('remote one'));
  assert.ok(r.removed.startsWith('[mcp_servers.db]'));
  assert.equal(r.text, '[mcp_servers."remote one"]\nurl = "https://h/p"\n[profile]\na=1\n');
  assert.equal(r.removed, '[mcp_servers.db]\ncommand = "x"\nenv = { K = "v" }\n\n');
  assert.deepEqual(S.tomlRemoveSection(TOML, 'nope'), { text: TOML, removed: null });
  assert.equal(S.tomlRemoveSection(TOML, 'remote one').removed.startsWith('[mcp_servers."remote one"]'), true);
});

// a multi-line array whose continuation lines start with "[" must not end the section
const ML = '[top]\nx = 1\n\n[mcp_servers.multi]\ncommand = "x"\nargs = [\n  ["a"],\n  ["b", "c"]\n]\n[mcp_servers.multi.env]\nK = "v"\n\n[mcp_servers.after]\ncommand = "y"\nstr = """\n[not.a.header]\nk = 1\n"""\n[[tail]]\nz = 2\n';

test('toml multi-line arrays stay inside their section', () => {
  assert.deepEqual(S.tomlMcpServers(ML), [
    { name: 'multi', keys: ['command', 'args', 'env'], transport: 'stdio' },
    { name: 'after', keys: ['command', 'str'], transport: 'stdio' }]);
  const r = S.tomlRemoveSection(ML, 'multi');
  assert.equal(r.removed, '[mcp_servers.multi]\ncommand = "x"\nargs = [\n  ["a"],\n  ["b", "c"]\n]\n[mcp_servers.multi.env]\nK = "v"\n\n');
  assert.equal(r.text, '[top]\nx = 1\n\n[mcp_servers.after]\ncommand = "y"\nstr = """\n[not.a.header]\nk = 1\n"""\n[[tail]]\nz = 2\n');
  // putting the removed text back where it was reproduces the original byte for byte
  const at = r.text.indexOf('[mcp_servers.after]');
  assert.equal(r.text.slice(0, at) + r.removed + r.text.slice(at), ML);
  // a multi-line string holding a header-looking line does not split the section; [[x]] still ends it
  const a = S.tomlRemoveSection(ML, 'after');
  assert.equal(a.removed, '[mcp_servers.after]\ncommand = "y"\nstr = """\n[not.a.header]\nk = 1\n"""\n');
  assert.ok(a.text.endsWith('[[tail]]\nz = 2\n'));
  // CRLF, comments after array lines, a "]" inside a string
  const crlf = '[mcp_servers.w]\r\nargs = [ # list ]\r\n  ["q]"] # one ]\r\n]\r\n[other]\r\nk = 1\r\n';
  const w = S.tomlRemoveSection(crlf, 'w');
  assert.equal(w.text, '[other]\r\nk = 1\r\n');
  assert.equal(w.removed + w.text, crlf);
  // an array that never closes: refuse instead of swallowing the rest of the file
  const open = '[mcp_servers.o]\nargs = [\n  "a",\n[other]\nk = 1\n';
  assert.deepEqual(S.tomlRemoveSection(open, 'o'), { text: open, removed: null });
});

const hook = (ev, agent) => ({ ts: 1730000000.5, ...(agent ? { agent } : {}), ev: { cwd: '/w/app', hook_event_name: 'PreToolUse', ...ev } });

test('usage key for plugin and plain skills', () => {
  const a = S.usageFromRecord(hook({ tool_name: 'Skill', tool_input: { skill: 'pixelfx:pixelfx' } }));
  assert.deepEqual(a, [{ key: 'pixelfx:pixelfx', kind: 'skill', agent: 'claude', at: 1730000000500, repo: 'app' }]);
  assert.equal(S.usageFromRecord(hook({ tool_name: 'Skill', tool_input: { skill: 'how' } }))[0].key, 'how');
  const m = S.usageFromRecord(hook({ tool_name: 'mcp__mysql-test__mysql_query' }, 'codex'))[0];
  assert.equal(m.key, 'mysql-test'); assert.equal(m.kind, 'mcp'); assert.equal(m.agent, 'codex');
  const p = S.usageFromRecord(hook({ hook_event_name: 'UserPromptSubmit', prompt: '/agent-picker do it' }));
  assert.equal(p[0].key, 'agent-picker');
  assert.deepEqual(S.usageFromRecord(hook({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'how' } })), []);
  assert.deepEqual(S.usageFromRecord(null), []);
});

test('transcript lines', () => {
  const ts = '2026-11-01T10:00:00Z';
  const a = S.usageFromTranscriptLine(JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Skill', input: { skill: 'orca-cli' } }] } }));
  assert.equal(a.length, 1); assert.equal(a[0].key, 'orca-cli'); assert.equal(a[0].at, Date.parse(ts));
  const u = S.usageFromTranscriptLine(JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: '<command-name>/teach</command-name>\n<command-args></command-args>' } }));
  assert.equal(u[0].key, 'teach');
  const u2 = S.usageFromTranscriptLine(JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: '/how it works' }] } }));
  assert.equal(u2[0].key, 'how');
  const mc = S.usageFromTranscriptLine(JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name: 'mcp__db__q', input: {} }] } }));
  assert.equal(mc[0].kind, 'mcp');
  assert.deepEqual(S.usageFromTranscriptLine('not json {'), []);
  assert.deepEqual(S.usageFromTranscriptLine(''), []);
});

test('mastery and week', () => {
  assert.equal(S.mastery(0), 0); assert.equal(S.mastery(4), 1); assert.equal(S.mastery(5), 2); assert.equal(S.mastery(19), 2); assert.equal(S.mastery(20), 3);
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  const day = off => { const d = new Date(2026, 10, 4 - off); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  assert.equal(S.weekCount({ [day(0)]: 2, [day(6)]: 1, [day(7)]: 9 }, now), 3);
});
