// AgentDesk status line relay — copied to ~/.roca/statusline-relay.cjs when the user turns on "usage without Orca".
// Claude Code runs it as the status line command (settings.json "statusLine") and pipes the session JSON on stdin:
//   1. the original status line command (kept in ~/.roca/statusline-orig.json) gets the same stdin; its stdout and
//      exit code pass through unchanged. No original command: nothing is printed.
//   2. only `rate_limits` (five_hour / seven_day: used_percentage, resets_at) and `session_id` are written to
//      ~/.roca/usage.json (0600, atomic) for the AgentDesk widget. Bad JSON or no rate_limits: nothing is written.
// Never throws: a failure here must not break the user's status line. No dependencies (Node built-ins only).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WINDOWS = ['five_hour', 'seven_day'];

// the record written to usage.json, or null when the input has no usable rate_limits
function usageRecord(text, now) {
  let j;
  try { j = JSON.parse(String(text || '')); } catch { return null; }
  const rl = j && typeof j === 'object' ? j.rate_limits : null;
  if (!rl || typeof rl !== 'object') return null;
  const out = {};
  for (const k of WINDOWS) {
    const w = rl[k];
    if (!w || typeof w !== 'object') continue;
    const pct = Number(w.used_percentage), at = Number(w.resets_at);
    if (w.used_percentage == null || !Number.isFinite(pct) || !Number.isFinite(at) || at <= 0) continue;
    out[k] = { used_percentage: pct, resets_at: at };
  }
  if (!Object.keys(out).length) return null;
  return { writtenAt: Number(now) || Date.now(), session_id: typeof j.session_id === 'string' ? j.session_id.slice(0, 100) : '', rate_limits: out };
}

function writeUsage(dir, rec) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'usage.json'), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, file);
  } catch {}
}

// the original statusLine command, or '' (none, not a command, unreadable)
function originalCommand(dir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, 'statusline-orig.json'), 'utf8'));
    const sl = o && o.had ? o.statusLine : null;
    if (!sl || typeof sl !== 'object' || (sl.type && sl.type !== 'command')) return '';
    return typeof sl.command === 'string' ? sl.command.trim() : '';
  } catch { return ''; }
}

function run(cmd, input, done) {
  let child;
  try {
    // the same kind of shell Claude Code runs a status line command in (POSIX sh; cmd.exe on Windows)
    child = process.platform === 'win32'
      ? spawn(cmd, { shell: true, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
      : spawn('/bin/sh', ['-c', cmd], { stdio: ['pipe', 'inherit', 'inherit'] });
  } catch { done(0); return null; }
  let finished = false;
  const end = code => { if (!finished) { finished = true; done(code); } };
  child.on('error', () => end(0));   // could not start: an empty status line, not an error
  child.on('exit', (code, signal) => end(signal ? 1 : (code == null ? 0 : code)));
  child.stdin.on('error', () => {});   // the command may not read its stdin (EPIPE)
  child.stdin.end(input);
  return child;
}

function main() {
  const dir = path.join(os.homedir(), '.roca');
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    const input = Buffer.concat(chunks);
    const cmd = originalCommand(dir);
    // start the original command first: the usage file is written while it runs
    const child = cmd ? run(cmd, input, code => process.exit(code)) : null;
    if (child) for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig); } catch {} process.exit(1); });
    const rec = usageRecord(input.toString('utf8'), Date.now());
    if (rec) writeUsage(dir, rec);
    if (!cmd) process.exit(0);
  });
}

if (require.main === module) main();
module.exports = { usageRecord, originalCommand };
