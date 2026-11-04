// Install plans (pure, no I/O): what would be installed and which commands run.
// `show` lines never contain user-typed values; `needs` lists env/header NAMES only.

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseSemver(v) {
  const m = SEMVER.exec(String(v ?? '').trim())
  return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] || '' } : null
}

export function hasUpdate(installedVersion, listedVersion) {
  const a = parseSemver(installedVersion)
  const b = parseSemver(listedVersion)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return b.n[i] > a.n[i]
  if (a.pre === b.pre) return false
  if (!a.pre) return false // installed is a release, listed a prerelease of the same version
  if (!b.pre) return true
  return b.pre > a.pre
}

const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)
const cmdLine = (argv) => argv.map(q).join(' ')
const has = (s, k) => !!s && typeof s.has === 'function' && s.has(k)

// "io.example/demo-srv" -> "demo-srv" (a name `claude mcp add` accepts)
export function mcpEntryName(name) {
  const last = String(name || '').split('/').pop()
  return last.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '') || 'server'
}

const argList = (list) => {
  const out = []
  for (const a of list || []) {
    if (!a || typeof a !== 'object') continue
    if (a.type === 'named' && a.name) { out.push(a.name); if (a.value != null && a.value !== '') out.push(String(a.value)) }
    else if (a.value != null && a.value !== '') out.push(String(a.value))
  }
  return out
}

const needNames = (list) =>
  (list || []).filter((x) => x && x.name && (x.isRequired || x.isSecret)).map((x) => x.name)

const placeholders = (names) => Object.fromEntries(names.map((n) => [n, '${' + n + '}']))

function candidates(rec) {
  const out = []
  const remotes = rec.remotes || []
  for (const type of ['streamable-http', 'sse']) {
    const r = remotes.find((x) => x && x.type === type && x.url)
    if (r) out.push({ via: 'remote', remote: r })
  }
  const pk = rec.packages || []
  const npm = pk.find((p) => p && p.registryType === 'npm')
  if (npm) out.push({ via: 'npm', pkg: npm })
  const py = pk.find((p) => p && p.registryType === 'pypi')
  if (py) out.push({ via: 'pypi', pkg: py })
  return out
}

function manualShow(rec) {
  const p = (rec.packages || [])[0]
  if (!p) return ['(no installable package listed)']
  const id = p.identifier
  const ver = p.version
  const args = [...argList(p.runtimeArguments), ...argList(p.packageArguments)]
  if (p.registryType === 'oci') return [cmdLine(['docker', 'run', '-i', '--rm', ver && !String(id).includes(':') ? `${id}:${ver}` : id, ...args])]
  if (p.registryType === 'nuget') return [cmdLine(['dnx', ver ? `${id}@${ver}` : id, '--yes', ...args])]
  if (p.registryType === 'npm') return [cmdLine(['npx', '-y', ver ? `${id}@${ver}` : id, ...args])]
  if (p.registryType === 'pypi') return [cmdLine(['uvx', ver ? `${id}==${ver}` : id, ...args])]
  return [cmdLine([id, ...args])]
}

function planMcp(item, installed, have) {
  const rec = item.registry || {}
  const name = mcpEntryName(item.name)
  if (has(installed?.mcp, name) || has(installed?.mcp, item.name)) {
    return { kind: 'installed', show: [`~/.claude.json mcpServers.${name}`], needs: [] }
  }
  const usable = candidates(rec).find((c) =>
    c.via === 'remote' || (c.via === 'npm' && have?.npx) || (c.via === 'pypi' && have?.uvx))
  if (!usable) {
    // docker/oci/nuget only, or the needed runner is missing: show the command to copy
    const first = candidates(rec).find((c) => c.via !== 'remote')
    const show = first
      ? manualShow({ packages: [first.pkg] })
      : manualShow(rec)
    return { kind: 'manual', show, needs: [] }
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
    cliTail = ['--transport', type, name, r.url]
    if (!needs.length && (r.auth || r.oauth || rec.auth || item.auth)) oauth = true
  } else {
    const p = usable.pkg
    const args = [...argList(p.runtimeArguments), ...argList(p.packageArguments)]
    needs = needNames(p.environmentVariables)
    const [command, base] = usable.via === 'npm'
      ? ['npx', ['-y', p.version ? `${p.identifier}@${p.version}` : p.identifier]]
      : ['uvx', [p.version ? `${p.identifier}==${p.version}` : p.identifier]]
    entry = { command, args: [...base, ...args] }
    if (needs.length) entry.env = placeholders(needs)
    cliTail = [name, '--', command, ...base, ...args]
  }

  if (needs.length) {
    return {
      kind: 'mcp-write',
      show: [`~/.claude.json mcpServers.${name}`, ...needs.map((n) => `  ${n}`)],
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
  const key = `${item.name}@${item.marketplace}`
  if (has(installed?.plugins, key)) return { kind: 'installed', show: [key], needs: [] }
  const steps = []
  if (!has(installed?.marketplaces, item.marketplace)) {
    const source = item.marketplaceSource || item.repo
    if (source) steps.push({ cmd: 'claude', args: ['plugin', 'marketplace', 'add', source] })
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
