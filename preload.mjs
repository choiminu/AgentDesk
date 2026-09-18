import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("orca", {
  ps: () => ipcRenderer.invoke("orca:ps"),
  terminals: () => ipcRenderer.invoke("orca:terminals"),
  worktrees: () => ipcRenderer.invoke("orca:worktrees"),
  terminalRead: (handle, screen) => ipcRenderer.invoke("orca:terminal-read", handle, screen),
  terminalSend: (handle, text, enter) => ipcRenderer.invoke("orca:terminal-send", handle, text, enter),
  terminalInterrupt: (handle) => ipcRenderer.invoke("orca:terminal-interrupt", handle),
  terminalClose: (handle) => ipcRenderer.invoke("orca:terminal-close", handle),
  terminalSwitch: (handle) => ipcRenderer.invoke("orca:terminal-switch", handle),
  worktreeCreate: (opts) => ipcRenderer.invoke("orca:worktree-create", opts),
  worktreeRm: (id) => ipcRenderer.invoke("orca:worktree-rm", id),
  openPath: (p) => ipcRenderer.invoke("orca:open-path", p),
  notify: (title, body) => ipcRenderer.invoke("orca:notify", title, body),
  toggleAlwaysOnTop: () => ipcRenderer.invoke("orca:toggle-always-on-top"),
  sendSessionCounts: (counts) => ipcRenderer.send("orca:session-counts", counts),
});
