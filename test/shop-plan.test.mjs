import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planInstall, hasUpdate } from '../shop/plan.mjs'

const EMPTY = () => ({ plugins: new Set(), mcp: new Set(), skills: new Set(), marketplaces: new Set() })
const HAVE = { npx: true, uvx: true }
const mcp = (registry, extra = {}) => ({ kind: 'mcp', name: 'io.example/demo-srv', source: 'registry', registry, ...extra })

test('plugin plan adds the marketplace only when unknown', () => {
  const item = { kind: 'plugin', name: 'helper', marketplace: 'acme-market', repo: 'acme/market' }
  const a = planInstall(item, { installed: EMPTY(), have: HAVE })
  assert.equal(a.kind, 'plugin')
  assert.deepEqual(a.steps, [
    { cmd: 'claude', args: ['plugin', 'marketplace', 'add', 'acme/market'] },
    { cmd: 'claude', args: ['plugin', 'install', 'helper@acme-market'] },
  ])
  const inst = EMPTY(); inst.marketplaces.add('acme-market')
  const b = planInstall(item, { installed: inst, have: HAVE })
  assert.deepEqual(b.steps, [{ cmd: 'claude', args: ['plugin', 'install', 'helper@acme-market'] }])
  assert.ok(b.show.some((l) => l.includes('helper@acme-market')))
})

test('remote http is preferred over npm', () => {
  const p = planInstall(mcp({
    packages: [{ registryType: 'npm', identifier: 'demo-pkg', version: '1.0.0', transport: { type: 'stdio' } }],
    remotes: [{ type: 'sse', url: 'https://sse.example.test/s' }, { type: 'streamable-http', url: 'https://mcp.example.test/mcp' }],
  }), { installed: EMPTY(), have: HAVE })
  assert.equal(p.kind, 'mcp-cli')
  assert.deepEqual(p.steps[0].args, ['mcp', 'add', '-s', 'user', '--transport', 'http', '--', 'demo-srv', 'https://mcp.example.test/mcp'])
  const s = planInstall(mcp({ remotes: [{ type: 'sse', url: 'https://sse.example.test/s' }] }), { installed: EMPTY(), have: HAVE })
  assert.ok(s.steps[0].args.includes('sse'))
})

test('npm package becomes npx -y pkg@version', () => {
  const p = planInstall(mcp({
    packages: [{ registryType: 'npm', identifier: '@ex/demo', version: '2.3.4', transport: { type: 'stdio' },
      packageArguments: [{ type: 'positional', value: 'serve' }] }],
  }), { installed: EMPTY(), have: HAVE })
  assert.equal(p.kind, 'mcp-cli')
  assert.deepEqual(p.steps[0].args, ['mcp', 'add', '-s', 'user', 'demo-srv', '--', 'npx', '-y', '@ex/demo@2.3.4', 'serve'])
  const w = planInstall(mcp({
    packages: [{ registryType: 'npm', identifier: '@ex/demo', version: '2.3.4', transport: { type: 'stdio' },
      packageArguments: [{ type: 'positional', value: 'serve' }], environmentVariables: [{ name: 'K', isRequired: true }] }],
  }), { installed: EMPTY(), have: HAVE })
  assert.deepEqual(w.entry, { command: 'npx', args: ['-y', '@ex/demo@2.3.4', 'serve'], env: { K: '${K}' } })
})

test('pypi becomes uvx', () => {
  const p = planInstall(mcp({
    packages: [{ registryType: 'pypi', identifier: 'demo-py', version: '0.4.1', transport: { type: 'stdio' } }],
  }), { installed: EMPTY(), have: HAVE })
  assert.deepEqual(p.steps[0].args, ['mcp', 'add', '-s', 'user', 'demo-srv', '--', 'uvx', 'demo-py==0.4.1'])
})

test('secret env makes a write plan with placeholders and names only', () => {
  const rec = {
    packages: [{ registryType: 'npm', identifier: 'demo-pkg', version: '1.0.0', transport: { type: 'stdio' },
      environmentVariables: [
        { name: 'API_TOKEN', description: 'tok', isRequired: true, isSecret: true, default: 'S3CRET-DEFAULT' },
        { name: 'OPTIONAL_FLAG', isRequired: false, isSecret: false, default: 'plain-default' },
      ] }],
    remotes: undefined,
  }
  const p = planInstall(mcp(rec), { installed: EMPTY(), have: HAVE })
  assert.equal(p.kind, 'mcp-write')
  assert.deepEqual(p.needs, ['API_TOKEN'])
  assert.deepEqual(p.entry.env, { API_TOKEN: '${API_TOKEN}' })
  assert.equal(p.steps, undefined)
  const json = JSON.stringify(p)
  assert.ok(!json.includes('S3CRET-DEFAULT') && !json.includes('plain-default'))
  const r = planInstall(mcp({ remotes: [{ type: 'streamable-http', url: 'https://mcp.example.test/mcp',
    headers: [{ name: 'Authorization', isRequired: true, isSecret: true, value: 'Bearer HDR-VALUE' }] }] }), { installed: EMPTY(), have: HAVE })
  assert.equal(r.kind, 'mcp-write')
  assert.deepEqual(r.needs, ['Authorization'])
  assert.equal(r.entry.type, 'http')
  assert.ok(!JSON.stringify(r).includes('HDR-VALUE'))
})

test('remote without static headers but with an auth hint is oauth', () => {
  const p = planInstall(mcp({ remotes: [{ type: 'streamable-http', url: 'https://mcp.example.test/mcp' }], auth: 'oauth' }), { installed: EMPTY(), have: HAVE })
  assert.equal(p.oauth, true)
  assert.equal(p.kind, 'mcp-cli')
})

test('docker only is manual', () => {
  const p = planInstall(mcp({ packages: [{ registryType: 'oci', identifier: 'ghcr.io/ex/demo', version: '1.0.0', transport: { type: 'stdio' } }] }), { installed: EMPTY(), have: HAVE })
  assert.equal(p.kind, 'manual')
  assert.ok(p.show[0].includes('docker') && p.show[0].includes('ghcr.io/ex/demo'))
  assert.equal(p.steps, undefined)
})

test('npx missing is manual', () => {
  const rec = { packages: [{ registryType: 'npm', identifier: 'demo-pkg', version: '1.0.0', transport: { type: 'stdio' } }] }
  const p = planInstall(mcp(rec), { installed: EMPTY(), have: { npx: false, uvx: true } })
  assert.equal(p.kind, 'manual')
  assert.ok(p.show[0].includes('npx -y demo-pkg@1.0.0'))
})

test('already installed', () => {
  const inst = EMPTY()
  inst.plugins.add('helper@acme-market'); inst.mcp.add('demo-srv'); inst.skills.add('my-skill')
  assert.equal(planInstall({ kind: 'plugin', name: 'helper', marketplace: 'acme-market' }, { installed: inst, have: HAVE }).kind, 'installed')
  assert.equal(planInstall(mcp({ remotes: [{ type: 'sse', url: 'https://x.example.test' }] }), { installed: inst, have: HAVE }).kind, 'installed')
  assert.equal(planInstall({ kind: 'skill', name: 'my-skill' }, { installed: inst, have: HAVE }).kind, 'installed')
  assert.equal(planInstall({ kind: 'skill', name: 'other' }, { installed: inst, have: HAVE }).kind, 'skill')
})

test('hasUpdate semver only', () => {
  assert.equal(hasUpdate('1.2.0', '1.10.0'), true)
  assert.equal(hasUpdate('1.10.0', '1.2.0'), false)
  assert.equal(hasUpdate('1.0.0', '1.0.0'), false)
  assert.equal(hasUpdate('abc123', 'def456'), false)
  assert.equal(hasUpdate('1.0.0', 'abc123'), false)
  assert.equal(hasUpdate('v1.0.0', '1.0.1'), true)
  assert.equal(hasUpdate('1.0.0-beta', '1.0.0'), true)
  assert.equal(hasUpdate(undefined, '1.0.0'), false)
})

test('hasUpdate compares prerelease identifiers per semver', () => {
  assert.equal(hasUpdate('1.0.0-beta.2', '1.0.0-beta.10'), true)
  assert.equal(hasUpdate('1.0.0-beta.10', '1.0.0-beta.2'), false)
  assert.equal(hasUpdate('1.0.0-alpha', '1.0.0'), true)
  assert.equal(hasUpdate('1.0.0', '1.0.0-alpha'), false)
  assert.equal(hasUpdate('1.0.0-alpha', '1.0.0-alpha.1'), true)
  assert.equal(hasUpdate('1.0.0-1', '1.0.0-alpha'), true)
  assert.equal(hasUpdate('1.0.0-alpha', '1.0.0-1'), false)
})

test('hostile values are rejected before any argv is built', () => {
  const bad = (rec) => planInstall(mcp(rec), { installed: EMPTY(), have: HAVE })
  const a = bad({ packages: [{ registryType: 'npm', identifier: '--registry=https://evil', version: '1.0.0', transport: { type: 'stdio' } }] })
  assert.equal(a.kind, 'manual'); assert.equal(a.steps, undefined)
  assert.ok(!JSON.stringify(a).includes('evil'))
  const b = bad({ packages: [{ registryType: 'npm', identifier: 'ok-pkg', version: '--x', transport: { type: 'stdio' } }] })
  assert.equal(b.kind, 'manual')
  const c = bad({ remotes: [{ type: 'streamable-http', url: '-x' }, { type: 'sse', url: 'http://evil.example.test/s' }] })
  assert.equal(c.kind, 'manual')
  assert.equal(bad({ remotes: [{ type: 'sse', url: 'http://localhost:3000/s' }] }).kind, 'mcp-cli')
  // invalid candidate falls through to the next valid one
  const d = bad({ remotes: [{ type: 'streamable-http', url: '-x' }],
    packages: [{ registryType: 'pypi', identifier: 'good-py', version: '1.0.0', transport: { type: 'stdio' } }] })
  assert.deepEqual(d.steps[0].args.slice(-2), ['uvx', 'good-py==1.0.0'])
  const e = bad({ packages: [{ registryType: 'oci', identifier: '--privileged', version: '1', transport: { type: 'stdio' } }] })
  assert.equal(e.kind, 'manual'); assert.ok(!e.show.join(' ').includes('docker'))
  assert.equal(planInstall({ kind: 'plugin', name: '--force', marketplace: 'm' }, { installed: EMPTY(), have: HAVE }).kind, 'manual')
  assert.equal(planInstall({ kind: 'plugin', name: 'p', marketplace: 'm', repo: '--upload-pack=x' }, { installed: EMPTY(), have: HAVE }).kind, 'manual')
})

test('secret arguments become placeholders and needs names', () => {
  const rec = { packages: [{ registryType: 'npm', identifier: 'demo-pkg', version: '1.0.0', transport: { type: 'stdio' },
    packageArguments: [
      { type: 'named', name: '--api-key', value: 'LEAK-ONE', isSecret: true },
      { type: 'named', name: '--url', value: 'https://h/{token}', variables: { token: { isSecret: true, default: 'LEAK-TWO' } } },
    ] }] }
  const p = planInstall(mcp(rec), { installed: EMPTY(), have: HAVE })
  assert.equal(p.kind, 'mcp-write')
  assert.deepEqual(p.needs, ['API_KEY', 'TOKEN'])
  assert.deepEqual(p.entry.args, ['-y', 'demo-pkg@1.0.0', '--api-key', '${API_KEY}', '--url', 'https://h/${TOKEN}'])
  assert.ok(!JSON.stringify(p).includes('LEAK'))
})

test('npx missing but uvx present falls through to pypi', () => {
  const rec = { packages: [
    { registryType: 'npm', identifier: 'demo-pkg', version: '1.0.0', transport: { type: 'stdio' } },
    { registryType: 'pypi', identifier: 'demo-py', version: '0.4.1', transport: { type: 'stdio' } }] }
  const p = planInstall(mcp(rec), { installed: EMPTY(), have: { npx: false, uvx: true } })
  assert.equal(p.kind, 'mcp-cli')
  assert.deepEqual(p.steps[0].args.slice(-2), ['uvx', 'demo-py==0.4.1'])
})

test('any runtime argument makes npx/uvx ineligible and docker non-runnable', () => {
  const mk = (registryType, identifier, runtimeArguments, packageArguments) =>
    ({ packages: [{ registryType, identifier, version: '1.0.0', transport: { type: 'stdio' }, runtimeArguments, packageArguments }] })
  const plan = (rec) => planInstall(mcp(rec), { installed: EMPTY(), have: HAVE })
  for (const ra of [
    [{ type: 'named', name: '-ihttps://evil.example.test' }],
    [{ type: 'positional', value: '-pX' }],
    [{ type: 'named', name: '--regis', value: 'https://evil.example.test' }],
    [{ type: 'named', name: '--node-option', value: 'x' }],
  ]) {
    for (const [t, id] of [['npm', 'demo-pkg'], ['pypi', 'demo-py']]) {
      const p = plan(mk(t, id, ra))
      assert.equal(p.kind, 'manual'); assert.equal(p.steps, undefined); assert.equal(p.entry, undefined)
      assert.ok(!/npx|uvx|evil/.test(p.show.join(' ')))
    }
  }
  const d = plan(mk('oci', 'ghcr.io/ex/demo', [{ type: 'named', name: '-v/:/host' }]))
  assert.equal(d.kind, 'manual'); assert.deepEqual(d.show, ['실행 인자가 있어 직접 확인이 필요합니다'])
  assert.equal(plan(mk('oci', 'ghcr.io/ex/demo', undefined)).show[0], 'docker run --rm -i ghcr.io/ex/demo:1.0.0')
  // an ineligible npm candidate falls through to a clean pypi one
  const f = plan({ packages: [mk('npm', 'demo-pkg', [{ type: 'named', name: '--registry', value: 'x' }]).packages[0], mk('pypi', 'demo-py').packages[0]] })
  assert.deepEqual(f.steps[0].args.slice(-2), ['uvx', 'demo-py==1.0.0'])
})

test('package argument values must not look like options', () => {
  const rec = (pa) => ({ packages: [{ registryType: 'npm', identifier: 'demo-pkg', version: '1.0.0', transport: { type: 'stdio' }, packageArguments: pa }] })
  const plan = (r) => planInstall(mcp(r), { installed: EMPTY(), have: HAVE })
  assert.equal(plan(rec([{ type: 'positional', value: '--evil' }])).kind, 'manual')
  assert.equal(plan(rec([{ type: 'named', name: '--port', value: '-1' }])).kind, 'manual')
  assert.equal(plan(rec([{ type: 'named', name: '--bad name', value: 'x' }])).kind, 'manual')
  assert.deepEqual(plan(rec([{ type: 'named', name: '--port', value: '80' }, { type: 'positional', value: 'serve' }])).entry.args, ['-y', 'demo-pkg@1.0.0', '--port', '80', 'serve'])
})
