// AgentDesk core: desktop integration for main.mjs — global shortcuts and start-at-login. Pure functions only.
//
//   SHORTCUTS                      → { action: accelerator } registered with globalShortcut while enabled
//   normalizeShortcutCfg(obj)      → { enabled } (off unless the saved file says enabled: true)
//   linuxAutostartDesktop(exec)    → the ~/.config/autostart/agentdesk.desktop text that starts this binary at login
(function (root) {
'use strict';

// main sends the renderer roca:shortcut { action } for each; the renderer decides what the action does
const SHORTCUTS = Object.freeze({ 'dock-toggle': 'CommandOrControl+Shift+D', 'perm-open': 'CommandOrControl+Shift+A' });

// off by default: ⌘⇧A / ⌘⇧D are taken system-wide once registered (Finder's Applications / Desktop, browser tab search)
function normalizeShortcutCfg(o) {
  return { enabled: !!(o && typeof o === 'object' && o.enabled === true) };
}

// Desktop Entry spec: the Exec argument is double-quoted and inside the quotes ", `, $ and \ get a backslash; then the
// string-value rule doubles every backslash (so a literal \ ends up as four) and % is written %% (field codes). A line
// break would end the key, so a path carrying one is refused.
function linuxAutostartDesktop(exec) {
  const p = String(exec == null ? '' : exec);
  if (!p || /[\r\n\0]/.test(p)) throw new Error('bad executable path');
  const q = ('"' + p.replace(/(["`$\\])/g, '\\$1') + '"').replace(/\\/g, '\\\\').replace(/%/g, '%%');
  return ['[Desktop Entry]', 'Type=Application', 'Name=AgentDesk', 'Comment=A pixel-art office for your AI coding agents',
    `Exec=${q}`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n');
}

const AgentDeskDesktop = { SHORTCUTS, normalizeShortcutCfg, linuxAutostartDesktop };
root.AgentDeskDesktop = AgentDeskDesktop;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskDesktop;
})(typeof globalThis !== 'undefined' ? globalThis : this);
