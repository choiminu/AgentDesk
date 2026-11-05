// Install plans (pure, no I/O): what would be installed and which commands run.
// `show` lines never contain user-typed values; `needs` lists env/header NAMES only.
import { isAbsolute } from 'node:path'

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseSemver(v) {
  const m = SEMVER.exec(String(v ?? '').trim())
  return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] || '' } : null
}

function cmpPre(x, y) {
  const a = x.split('.'), b = y.split('.')
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const an = /^\d+$/.test(a[i]), bn = /^\d+$/.test(b[i])
    if (an && bn) { if (+a[i] !== +b[i]) return +a[i] < +b[i] ? -1 : 1 }
    else if (an !== bn) return an ? -1 : 1
    else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

export function hasUpdate(installedVersion, listedVersion) {
  const a = parseSemver(installedVersion)
  const b = parseSemver(listedVersion)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return b.n[i] > a.n[i]
  if (a.pre === b.pre) return false
  if (!b.pre) return true // listed is the release, installed a prerelease
  if (!a.pre) return false
  return cmpPre(a.pre, b.pre) < 0
}

// Values that reach an argv must not look like options and must match a conservative shape.
const RE = {
  npm: /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/,
  pypi: /^[A-Za-z0-9._-]+$/,
  ver: /^[A-Za-z0-9._+-]+$/,
  oci: /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/,
  nuget: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  plugin: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  ghRepo: /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
}
const okVer = (v) => v == null || v === '' || (RE.ver.test(v) && !String(v).startsWith('-'))
const okPkg = (p) => {
  if (!p || typeof p.identifier !== 'string' || String(p.identifier).startsWith('-') || !okVer(p.version)) return false
  const re = RE[{ npm: 'npm', pypi: 'pypi', oci: 'oci', nuget: 'nuget' }[p.registryType]]
  return !!re && re.test(p.identifier)
}
function okUrl(u) {
  if (typeof u !== 'string' || u.startsWith('-')) return false
  try {
    const x = new URL(u)
    if (x.protocol === 'https:') return true
    return x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)
  } catch { return false }
}
const okSource = (s) => typeof s === 'string' && !s.startsWith('-') && (RE.ghRepo.test(s) || /^https:\/\/[^\s]+$/.test(s))
const hasRuntimeArgs = (p) => Array.isArray(p.runtimeArguments) && p.runtimeArguments.length > 0
// package arguments (after the package): a value must not look like an option, unless it belongs to a
// well-formed named argument.
function okPackageArgs(list) {
  return (list || []).every((a) => {
    if (!a || typeof a !== 'object') return true
    const v = a.value != null && a.value !== '' ? String(a.value) : null
    if (v && v.startsWith('-')) return false
    if (a.type === 'named') return typeof a.name === 'string' && /^--?[A-Za-z][A-Za-z0-9-]*$/.test(a.name)
    return true
  })
}
const RUNARGS = ['실행 인자가 있어 직접 확인이 필요합니다']
const CANNOT = ['자동 설치 불가 — 레지스트리 정보를 확인하세요 (cannot be installed automatically)']

const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)
const cmdLine = (argv) => argv.map(q).join(' ')
const has = (s, k) => !!s && typeof s.has === 'function' && s.has(k)

// "io.example/demo-srv" -> "demo-srv" (a name `claude mcp add` accepts)
export function mcpEntryName(name) {
  const last = String(name || '').split('/').pop()
  return last.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '') || 'server'
}

const safeVar = (n) => String(n).replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'ARG'

// Turns registry arguments into argv words. Secret values (isSecret, or a {var} template naming a secret
// variable) never get copied: they become "${NAME}" placeholders and NAME is pushed to `needs`.
function argWords(list, needs) {
  const out = []
  for (const [i, a] of (list || []).entries()) {
    if (!a || typeof a !== 'object') continue
    let value = a.value != null && a.value !== '' ? String(a.value) : null
    const vars = a.variables && typeof a.variables === 'object' ? a.variables : {}
    if (a.isSecret) {
      const names = value ? [...value.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]) : []
      const n = safeVar(names.length === 1 ? names[0] : a.name || `ARG_${i}`)
      needs.push(n)
      value = '${' + n + '}'
    } else if (value) {
      value = value.replace(/\{([^{}]+)\}/g, (m, v) => {
        if (!vars[v]?.isSecret) return m
        const n = safeVar(v)
        needs.push(n)
        return '${' + n + '}'
      })
    } else if (a.type !== 'named') continue
    if (a.type === 'named' && a.name) { out.push(a.name); if (value != null) out.push(value) }
    else if (value != null) out.push(value)
  }
  return out
}

// a secret package argument would put the typed value on the server's own command line (visible to `ps`):
// such a package is never installed automatically (secrets may only go to entry.env / entry.headers)
function secretArgs(p) {
  const needs = []
  argWords(p.packageArguments, needs)
  return needs.length > 0
}

const needNames = (list) =>
  (list || []).filter((x) => x && x.name && (x.isRequired || x.isSecret)).map((x) => x.name)

const placeholders = (names) => Object.fromEntries(names.map((n) => [n, '${' + n + '}']))
const uniq = (a) => [...new Set(a)]

function candidates(rec) {
  const out = []
  const remotes = rec.remotes || []
  for (const type of ['streamable-http', 'sse']) {
    const r = remotes.find((x) => x && x.type === type && okUrl(x.url))
    if (r) out.push({ via: 'remote', remote: r })
  }
  const pk = (rec.packages || []).filter((p) => okPkg(p) && !hasRuntimeArgs(p) && okPackageArgs(p.packageArguments) && !secretArgs(p))
  const npm = pk.find((p) => p.registryType === 'npm')
  if (npm) out.push({ via: 'npm', pkg: npm })
  const py = pk.find((p) => p.registryType === 'pypi')
  if (py) out.push({ via: 'pypi', pkg: py })
  return out
}

function manualShow(p) {
  if (!okPkg(p)) return CANNOT
  if (hasRuntimeArgs(p)) return RUNARGS
  if (!okPackageArgs(p.packageArguments)) return CANNOT
  if (secretArgs(p)) return CANNOT
  const id = p.identifier
  const ver = p.version
  const needs = []
  const pa = argWords(p.packageArguments, needs)
  if (p.registryType === 'oci') return [cmdLine(['docker', 'run', '--rm', '-i', ver && !String(id).includes(':') ? `${id}:${ver}` : id, ...pa])]
  if (p.registryType === 'nuget') return [cmdLine(['dnx', ver ? `${id}@${ver}` : id, '--yes', ...pa])]
  if (p.registryType === 'npm') return [cmdLine(['npx', '-y', ver ? `${id}@${ver}` : id, ...pa])]
  if (p.registryType === 'pypi') return [cmdLine(['uvx', ver ? `${id}==${ver}` : id, ...pa])]
  return CANNOT
}

function planMcp(item, installed, have) {
  const rec = item.registry || {}
  const name = mcpEntryName(item.name)
  if (has(installed?.mcp, name) || has(installed?.mcp, item.name)) {
    return { kind: 'installed', show: [`~/.claude.json mcpServers.${name}`], needs: [] }
  }
  const cands = candidates(rec)
  const usable = cands.find((c) =>
    c.via === 'remote' || (c.via === 'npm' && have?.npx) || (c.via === 'pypi' && have?.uvx))
  if (!usable) {
    // docker/oci/nuget only, or the needed runner is missing: show the command to copy
    const first = cands.find((c) => c.via !== 'remote')?.pkg
      || (rec.packages || []).find((p) => okPkg(p) && !hasRuntimeArgs(p))
      || (rec.packages || []).find((p) => okPkg(p))
    return { kind: 'manual', show: first ? manualShow(first) : CANNOT, needs: [] }
  }

  let entry
  let cliTail // argv after `claude mcp add -s user`
  let needs
  let oauth = false
  if (usable.via === 'remote') {
    const r = usable.remote
    const type = r.type === 'sse' ? 'sse' : 'http'
    needs = needNames(r.headers)
    entry = { type, url: r.url }
    if (needs.length) entry.headers = placeholders(needs)
    cliTail = ['--transport', type, '--', name, r.url]
    if (!needs.length && (r.auth || r.oauth || rec.auth || item.auth)) oauth = true
  } else {
    const p = usable.pkg
    needs = needNames(p.environmentVariables)
      const pa = argWords(p.packageArguments, needs)
    const [command, pre, ref] = usable.via === 'npm'
      ? ['npx', ['-y'], p.version ? `${p.identifier}@${p.version}` : p.identifier]
      : ['uvx', [], p.version ? `${p.identifier}==${p.version}` : p.identifier]
    const args = [...pre, ref, ...pa]
    needs = uniq(needs)
    entry = { command, args }
    if (needs.length) entry.env = placeholders(needs.filter((n) => needNames(p.environmentVariables).includes(n)))
    if (!Object.keys(entry.env || {}).length) delete entry.env
    cliTail = [name, '--', command, ...args]
  }
  needs = uniq(needs)
  // a registry value holding "$" in the URL, command or arguments could make Claude Code expand a variable of this
  // machine (a token) into where the server connects or what it runs: not installed automatically
  if (JSON.stringify([entry.url, entry.command, entry.args]).includes('$')) return { kind: 'manual', show: CANNOT, needs: [] }

  if (needs.length) {
    return {
      kind: 'mcp-write',
      // where the typed values go (the remote URL, or the package that receives them), then their names
      show: [`~/.claude.json mcpServers.${name}`, `  → ${entry.url || cmdLine([entry.command, ...entry.args])}`, ...needs.map((n) => `  ${n}`)],
      needs,
      entry,
      ...(oauth ? { oauth } : {}),
    }
  }
  const argv = ['mcp', 'add', '-s', 'user', ...cliTail]
  return {
    kind: 'mcp-cli',
    show: [cmdLine(['claude', ...argv])],
    needs: [],
    steps: [{ cmd: 'claude', args: argv }],
    entry,
    ...(oauth ? { oauth } : {}),
  }
}

function planPlugin(item, installed) {
  if (!RE.plugin.test(item.name || '') || !RE.plugin.test(item.marketplace || '')) {
    return { kind: 'manual', show: CANNOT, needs: [] }
  }
  const key = `${item.name}@${item.marketplace}`
  if (has(installed?.plugins, key)) return { kind: 'installed', show: [key], needs: [] }
  const steps = []
  if (!has(installed?.marketplaces, item.marketplace)) {
    // a pasted /tree/<ref>/<path> link: the previewed folder (inside ~/.roca/shop; install.mjs checks) is added as a
    // local-path marketplace, so what installs is what was shown — not the default branch root of owner/repo
    const local = typeof item.marketplacePath === 'string' && isAbsolute(item.marketplacePath) && !/[\u0000-\u001f\u007f]/.test(item.marketplacePath)
      ? item.marketplacePath : null
    const source = local || item.marketplaceSource || item.repo
    if (local) steps.push({ cmd: 'claude', args: ['plugin', 'marketplace', 'add', local] })
    else if (source) {
      if (!okSource(source)) return { kind: 'manual', show: CANNOT, needs: [] }
      steps.push({ cmd: 'claude', args: ['plugin', 'marketplace', 'add', source] })
    }
  }
  steps.push({ cmd: 'claude', args: ['plugin', 'install', key] })
  return { kind: 'plugin', show: steps.map((s) => cmdLine([s.cmd, ...s.args])), needs: [], steps }
}

export function planInstall(item, { installed = {}, have = {} } = {}) {
  if (item.kind === 'plugin') return planPlugin(item, installed)
  if (item.kind === 'mcp') return planMcp(item, installed, have)
  if (item.kind === 'skill') {
    if (has(installed?.skills, item.name)) return { kind: 'installed', show: [`~/.claude/skills/${item.name}`], needs: [] }
    return { kind: 'skill', show: [`~/.claude/skills/${item.name}`], needs: [] }
  }
  return { kind: 'manual', show: [], needs: [] }
}
