#!/usr/bin/env node
// AgentDesk's pixel icons: the colour emoji the widget shows (⚙ 📖 🗡 …) drawn as 12 x 12 pixel art in the office /
// Skillbook palette. Run `node scripts/pixel-icons.mjs` after editing a grid: it rewrites the block between the
// "pxi:css" markers in widget.html (one .pxi-<name> rule per icon, an inline SVG of 1 x 1 rects) and the PXI_EMOJI
// table between the "pxi:map" markers. The widget swaps those emoji for <i class="pxi pxi-<name>"> as it draws text
// (pxiDecorate). Our own drawings; no third-party art.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PAL = { K: '#2a2230', W: '#fff6e0', L: '#c9c2b0', s: '#a8a4b0', S: '#6b6776', b: '#5b8fd9', B: '#2f5a9e', c: '#7fd3ef', y: '#f2c14e', Y: '#b88a1e', o: '#ec8a3a', r: '#d9534f', R: '#8e2a22', n: '#9a6334', N: '#5c3a1c', g: '#5cb85c', G: '#2e7d32', t: '#efd3a8' };
const slash = (rows) => rows.map((row, y) => [...row].map((ch, x) => (x === 11 - y ? 'r' : x === 10 - y && y > 0 ? 'K' : ch)).join(''));
const BELL = ['.....KK.....', '....KyyK....', '...KyyyyK...', '..KyyWyyyK..', '..KyWyyyyK..', '..KyyyyyyK..', '..KyyyyyyK..', '.KyyyyyyyyK.', 'KyyyyyyyyyyK', 'KKKKKKKKKKKK', '....KYYK....', '.....KK.....'];
const EYE = ['............', '............', '...KKKKKK...', '.KKWWWWWWKK.', 'KWWWKbbKWWWK', 'KWWKbbKbKWWK', 'KWWKbbbbKWWK', 'KWWWKbbKWWWK', '.KKWWWWWWKK.', '...KKKKKK...', '............', '............'];
const TRAY = ['KK........KK', 'KsK......KsK', 'KsKKK..KKKsK', 'KssssKKssssK', 'KssssssssssK', 'KKKKKKKKKKKK'];
export const ICONS = {
  gear: ['....KKKK....', '.KK.KssK.KK.', '.KsKKssKKsK.', '..KssWssssK.', 'KKKsWKKssKKK', 'KsssK..KsssK', 'KsssK..KsssK', 'KKKssKKssKKK', '..KssssssK..', '.KsKKssKKsK.', '.KK.KssK.KK.', '....KKKK....'],
  book: ['............', '.KKKK..KKKK.', 'KWWWWKKWWWWK', 'KWLLWKKWLLWK', 'KWWWWKKWWWWK', 'KWLLWKKWLLWK', 'KWWWWKKWWWWK', 'KWLLWKKWLLWK', 'KWWWWKKWWWWK', 'KBBBBKKBBBBK', '.KKKKBBKKKK.', '.....KK.....'],
  sword: ['.........KKK', '........KWsK', '.......KWsK.', '......KWsK..', '.....KWsK...', '.KK.KWsK....', '.KyKWsK.....', '..KyyK......', '..KnKyK.....', '.KnK.KyK....', 'KnK...KK....', 'KK..........'],
  shop: ['.KKKKKKKKKK.', 'KrrWWrrWWrrK', 'KrrWWrrWWrrK', 'KKKKKKKKKKKK', '.Kn......nK.', '.Kn.KKK..nK.', '.Kn.KyK..nK.', '.Kn.KKK..nK.', 'KKKKKKKKKKKK', 'KnnnnnnnnnnK', 'KnNnNnNnNnnK', 'KKKKKKKKKKKK'],
  key: ['............', '............', '.KKKK.......', 'KyyyyK......', 'KyKKyK......', 'KyKKyKKKKKKK', 'KyyyyyyyyyyK', '.KKKKKKyKyKK', '.......KK.K.', '............', '............', '............'],
  zzz: ['......bbbbb.', '.........b..', '........b...', '.......bbbbb', '............', 'bbbbbb......', '....b.......', '...b........', '..b.........', '.b..........', 'bbbbbb......', '............'],
  ticket: ['............', '............', 'KKKKKKKKKKKK', 'KooKoooooooK', 'KooKoWWWWooK', '.KoKooooooK.', '.KoKoWWWooK.', 'KooKoooooooK', 'KKKKKKKKKKKK', '............', '............', '............'],
  shield: ['KKKKKKKKKKKK', 'KssssssssssK', 'KsbbbbWbbbsK', 'KsbbbWWbbbsK', 'KsbbbbWbbbsK', 'KsbbbbbbbbsK', '.KsbbbbbbsK.', '.KsbbbbbbsK.', '..KsbbbbsK..', '...KsbbsK...', '....KssK....', '.....KK.....'],
  warn: ['.....KK.....', '....KyyK....', '....KyyK....', '...KyKKyK...', '...KyKKyK...', '..KyyKKyyK..', '..KyyKKyyK..', '.KyyyyyyyyK.', '.KyyyKKyyyK.', 'KyyyyyyyyyyK', 'KKKKKKKKKKKK', '............'],
  mail: ['............', '............', 'KKKKKKKKKKKK', 'KKWWWWWWWWKK', 'KWKWWWWWWKWK', 'KWWKWWWWKWWK', 'KWWWKKKKWWWK', 'KWWWWWWWWWWK', 'KWWWWWWWWWWK', 'KKKKKKKKKKKK', '............', '............'],
  inbox: ['.....KK.....', '....KbbK....', '....KbbK....', '..KKKbbKKK..', '...KbbbbK...', '....KbbK....', ...TRAY],
  empty: ['............', '............', '............', '............', '............', '............', ...TRAY],
  question: ['.KKKKKKKKKK.', 'KyyyyyyyyyyK', 'KyyyKKKKyyyK', 'KyyKyyyyKyyK', 'KyyyyyyKKyyK', 'KyyyyyKKyyyK', 'KyyyyyKyyyyK', 'KyyyyyyyyyyK', 'KyyyyyKyyyyK', '.KKKKKKKKKK.', '...KyK......', '...KK.......'],
  bell: BELL,
  bellOff: slash(BELL),
  pin: ['....KKKK....', '...KrrrrK...', '...KrWrrK...', '...KrrrrK...', '..KKrrrrKK..', '.KrrrrrrrrK.', '.KKKKKKKKKK.', '.....KK.....', '.....KS.....', '.....KS.....', '......K.....', '............'],
  chart: ['............', '........KKK.', '........KgK.', '....KKK.KgK.', '....KbK.KgK.', 'KKK.KbK.KgK.', 'KrK.KbK.KgK.', 'KrK.KbK.KgK.', 'KrK.KbK.KgK.', 'KrK.KbK.KgK.', 'KKKKKKKKKKKK', '............'],
  link: ['............', '............', '..KKKK.KKKK.', '.KssssKssssK', 'KsKKKssKKKsK', 'KsK..KsK..sK', 'KsKKKssKKKsK', '.KssssKssssK', '..KKKK.KKKK.', '............', '............', '............'],
  stopwatch: ['....KKKK....', '.....KK.....', '...KKKKKK.K.', '..KWWWWWWKK.', '.KWWWWKWWWK.', '.KWWWWKWWWK.', '.KWWWWKKKWK.', '.KWWWWWWWWK.', '.KWWWWWWWWK.', '..KWWWWWWK..', '...KKKKKK...', '............'],
  clipboard: ['....KKKK....', '.KKKKssKKKK.', '.KnnKKKKnnK.', '.KnWWWWWWnK.', '.KnWLLLLWnK.', '.KnWWWWWWnK.', '.KnWLLLLWnK.', '.KnWWWWWWnK.', '.KnWLLLWWnK.', '.KnWWWWWWnK.', '.KnnnnnnnnK.', '.KKKKKKKKKK.'],
  chat: ['............', '.KKKKKKKKKK.', 'KWWWWWWWWWWK', 'KWWWWWWWWWWK', 'KWWSWWSWWSWK', 'KWWWWWWWWWWK', 'KWWWWWWWWWWK', '.KKKKKKKKKK.', '..KWK.......', '..KK........', '............', '............'],
  scroll: ['.KKKKKKKKKK.', 'KttttttttttK', '.KKKKKKKKKK.', '.KtttttttK..', '.KtLLLLLtK..', '.KtttttttK..', '.KtLLLLttK..', '.KtttttttK..', '.KtLLLLLtK..', '.KKKKKKKKKK.', 'KttttttttttK', '.KKKKKKKKKK.'],
  coffee: ['...L..L.....', '....L..L....', '...L..L.....', 'KKKKKKKKKK..', 'KWWWWWWWWKK.', 'KWnnnnnnWKKK', 'KWWWWWWWWK.K', 'KWWWWWWWWKKK', 'KWWWWWWWWKK.', '.KWWWWWWK...', '..KKKKKK....', '............'],
  fire: ['.....K......', '....KrK.....', '....KrrK....', '...KrrrK.K..', '..KrrorrKrK.', '..KrroorrrK.', '.KrrooyorrK.', '.KroyyyyorK.', '.KroyWWyorK.', '.KroyWWyorK.', '..KrooooorK.', '...KKKKKKK..'],
  toolbox: ['............', '....KKKK....', '...KK..KK...', '.KKKKKKKKKK.', 'KrrrrrrrrrrK', 'KrrrrrrrrrrK', 'KKKKKyyKKKKK', 'KrrrrKKrrrrK', 'KrrrrrrrrrrK', 'KrrrrrrrrrrK', 'KKKKKKKKKKKK', '............'],
  puzzle: ['.....KK.....', '....KggK....', '..KKKggKKK..', '..KggggggK..', '..KggggggKK.', '..KgggggggK.', '..KgggggggK.', '..KggggggKK.', '..KggggggK..', '..KKKKKKKK..', '............', '............'],
  crown: ['............', '............', 'K....KK....K', 'KK..KyyK..KK', 'KyK.KyyK.KyK', 'KyyKyyyyKyyK', 'KyyyyyyyyyyK', 'KyyryyyybyyK', 'KyyyyyyyyyyK', 'KKKKKKKKKKKK', '............', '............'],
  calendar: ['..K.....K...', '.KKKKKKKKKK.', '.KrrrrrrrrK.', '.KrrrrrrrrK.', '.KKKKKKKKKK.', '.KWWWWWWWWK.', '.KWSWSWSWWK.', '.KWWWWWWWWK.', '.KWSWSWrWWK.', '.KWWWWWWWWK.', '.KKKKKKKKKK.', '............'],
  lock: ['....KKKK....', '...KssssK...', '..KsK..KsK..', '..KsK..KsK..', '.KKKKKKKKKK.', '.KyyyyyyyyK.', '.KyyyKKyyyK.', '.KyyyKKyyyK.', '.KyyyyKyyyK.', '.KyyyyyyyyK.', '.KKKKKKKKKK.', '............'],
  monitor: ['KKKKKKKKKKKK', 'KbbbbbbbbbbK', 'KbcbbbbbbbbK', 'KbbbbbbbbbbK', 'KbbbbbbbbbbK', 'KbbbbbbbbbbK', 'KKKKKKKKKKKK', '.....KK.....', '....KssK....', '..KKKKKKKK..', '............', '............'],
  eye: EYE,
  hidden: slash(EYE),
  robot: ['.....yy.....', '.....KK.....', '..KKKKKKKK..', '.KssssssssK.', 'KKsccssccsKK', 'KKsccssccsKK', '.KssssssssK.', '.KssKKKKssK.', '.KssssssssK.', '..KKKKKKKK..', '............', '............'],
  memo: ['KKKKKKKK....', 'KWWWWWWK....', 'KWLLLLWK..K.', 'KWWWWWWK.KyK', 'KWLLLLWKKyK.', 'KWWWWWKKyK..', 'KWLLLKKyK...', 'KWWWKnyK....', 'KWWWKnK.....', 'KWWWWKK.....', 'KKKKKKK.....', '............'],
  pencil: ['.........KK.', '........KrrK', '.......KyyKK', '......KyyK..', '.....KyyK...', '....KyyK....', '...KyyK.....', '..KttK......', '..KtK.......', '.KKK........', '.KK.........', '............'],
  sparkle: ['....y.......', '...yyy......', '.yyyWyyy....', '...yyy......', '....y....y..', '........yWy.', '.y.......y..', 'yWy.........', '.y....y.....', '.....yWy....', '......y.....', '............'],
  hand: ['...K.K.K....', '..KtKtKtK...', '..KtKtKtKK..', '..KtKtKtKtK.', '..KtttttttK.', 'KK.KttttttK.', 'KtKKttttttK.', '.KttttttttK.', '..KtttttttK.', '...KttttttK.', '....KKKKKK..', '............'],
  broom: ['..........KK', '.........KnK', '........KnK.', '.......KnK..', '......KnK...', '...KKKKK....', '..KyyyyyK...', '.KyyyyyyK...', '.KyYyYyYK...', 'KyYyYyYK....', 'KKKKKKK.....', '............'],
  hourglass: ['.KKKKKKKKKK.', '..KWWWWWWK..', '..KWyyyyWK..', '...KWyyWK...', '....KyyK....', '....KWWK....', '...KWWyWK...', '..KWWyyyWK..', '..KyyyyyyK..', '.KKKKKKKKKK.', '............', '............'],
  party: ['........r..b', '..y....K....', '......KyK.g.', '.b...KrrK...', '....KyyyK.r.', '...KrrrrK...', '..KyyyyyK...', '.KrrrrrrK.y.', 'KyyyyyyyK...', 'KKKKKKKKK...', '..g...b.....', '............'],
  palette: ['...KKKKKK...', '..KttttttK..', '.KtrrttbbtK.', 'KttrrttbbttK', 'KttttttttttK', 'KtggtttKKttK', 'KtggttK..KtK', '.KtttK....K.', '.KttttKKKK..', '..KKKKK.....', '............', '............'],
  box: ['............', '...KKKKKK...', '..KnnnnnnK..', '.KKKKKKKKKK.', '.KnnnKKnnnK.', '.KnnnKKnnnK.', '.KNnnnnnnNK.', '.KnnnnnnnnK.', '.KnnnnnnnnK.', '.KKKKKKKKKK.', '............', '............'],
  flask: ['....KKKK....', '....KWWK....', '....KWWK....', '....KWWK....', '...KWWWWK...', '..KWWWWWWK..', '.KggggggggK.', '.KggWgggggK.', '.KggggggggK.', '..KKKKKKKK..', '............', '............'],
  bolt: ['......KKKK..', '.....KyyK...', '....KyyK....', '...KyyKKKK..', '..KyyyyyyK..', '..KKKKyyK...', '.....KyK....', '....KyK.....', '...KyK......', '...KK.......', '............', '............'],
  trash: ['....KKKK....', '.KKKKKKKKKK.', '.KssssssssK.', '.KKKKKKKKKK.', '..KsSsSsSK..', '..KsSsSsSK..', '..KsSsSsSK..', '..KsSsSsSK..', '..KsSsSsSK..', '..KKKKKKKK..', '............', '............'],
  compass: ['...KKKKKK...', '..KWWWWWWK..', '.KWWWWWrrWK.', 'KWWWWWrrWWWK', 'KWWWWrrWWWWK', 'KWWWWsKWWWWK', 'KWWWssWWWWWK', 'KWWssWWWWWWK', '.KWsWWWWWWK.', '..KWWWWWWK..', '...KKKKKK...', '............'],
  tag: ['............', '....KKKKKKKK', '...KoooooooK', '..KoKKoooooK', '.KooKKoooooK', '..KooooooooK', '...KoooooooK', '....KKKKKKKK', '............', '............', '............', '............'],
  plug: ['..s..s......', '..s..s......', '.KKKKKK.....', '.KssssK.....', '.KssssK.....', '..KssK......', '...SS.......', '...SS.......', '....SS......', '.....SSS....', '.......SSSS.', '............'],
  check: ['KKKKKKKKKKKK', 'KggggggggggK', 'KggggggggWgK', 'KgggggggWWgK', 'KgWgggggWggK', 'KgWWgggWWggK', 'KggWWgWWgggK', 'KgggWWWggggK', 'KggggWgggggK', 'KggggggggggK', 'KKKKKKKKKKKK', '............'],
  person: ['....KKKK....', '...KttttK...', '...KttttK...', '...KttttK...', '....KKKK....', '..KKbbbbKK..', '.KbbbbbbbbK.', '.KbbbbbbbbK.', '.KbbbbbbbbK.', '.KKKKKKKKKK.', '............', '............'],
  people: ['..KKK..KKK..', '.KtttKKtttK.', '.KtttKKtttK.', '..KKK..KKK..', 'KKbbbKKgggKK', 'KbbbbKKggggK', 'KbbbbKKggggK', 'KbbbbKKggggK', 'KKKKKKKKKKKK', '............', '............', '............'],
  page: ['.KKKKKK.....', '.KWWWWKK....', '.KWWWWKWK...', '.KWWWWKKKK..', '.KWLLLLWWK..', '.KWWWWWWWK..', '.KWLLLLLWK..', '.KWWWWWWWK..', '.KWLLLLWWK..', '.KWWWWWWWK..', '.KKKKKKKKK..', '............'],
  globe: ['...KKKKKK...', '..KbbggbbK..', '.KbgggggbbK.', 'KbbggggbbggK', 'KbbbgggbbggK', 'KbbbbgbbbbgK', 'KbbbbbbbgbbK', '.KbbbbbggbK.', '..KbbbbbbK..', '...KKKKKK...', '............', '............'],
  traffic: ['....KKKK....', '...KSSSSK...', '...KSrrSK...', '...KSrrSK...', '...KSSSSK...', '...KSyySK...', '...KSyySK...', '...KSSSSK...', '...KSggSK...', '...KSggSK...', '...KSSSSK...', '....KKKK....'],
  pause: ['............', '..KKK..KKK..', '..KsK..KsK..', '..KsK..KsK..', '..KsK..KsK..', '..KsK..KsK..', '..KsK..KsK..', '..KsK..KsK..', '..KsK..KsK..', '..KKK..KKK..', '............', '............'],
  stop: ['............', '..KKKKKKKK..', '..KrrrrrrK..', '..KrrrrrrK..', '..KrrrrrrK..', '..KrrrrrrK..', '..KrrrrrrK..', '..KrrrrrrK..', '..KKKKKKKK..', '............', '............', '............'],
  download: ['.....KK.....', '....KbbK....', '....KbbK....', '....KbbK....', '.KKKKbbKKKK.', '..KbbbbbbK..', '...KbbbbK...', '....KbbK....', '.....KK.....', 'KK........KK', 'KKKKKKKKKKKK', '............'],
  heart: ['..KK....KK..', '.KrrK..KrrK.', 'KrWrrKKrrrrK', 'KrrrrrrrrrrK', 'KrrrrrrrrrrK', '.KrrrrrrrrK.', '..KrrrrrrK..', '...KrrrrK...', '....KrrK....', '.....KK.....', '............', '............'],
};
// emoji (with or without the U+FE0F variation selector) → icon
export const EMOJI = {
  '⚙': 'gear', '📖': 'book', '🗡': 'sword', '🏪': 'shop', '🔑': 'key', '💤': 'zzz', '🎫': 'ticket', '🎟': 'ticket', '🛡': 'shield', '⚠': 'warn',
  '✉': 'mail', '📥': 'inbox', '📭': 'empty', '❓': 'question', '🔔': 'bell', '🔕': 'bellOff', '📌': 'pin', '📊': 'chart', '🔗': 'link', '⏱': 'stopwatch',
  '📋': 'clipboard', '💬': 'chat', '📜': 'scroll', '☕': 'coffee', '🔥': 'fire', '🧰': 'toolbox', '🧩': 'puzzle', '👑': 'crown', '📅': 'calendar',
  '🔐': 'lock', '🔒': 'lock', '🖥': 'monitor', '👁': 'eye', '👀': 'eye', '🙈': 'hidden', '🤖': 'robot', '📝': 'memo', '✏': 'pencil', '✨': 'sparkle',
  '✋': 'hand', '🧹': 'broom', '⏳': 'hourglass', '🎉': 'party', '🎨': 'palette', '📦': 'box', '🧪': 'flask', '⚡': 'bolt', '🗑': 'trash', '🧭': 'compass',
  '🏷': 'tag', '🔌': 'plug', '✅': 'check', '👤': 'person', '👥': 'people', '📄': 'page', '🌐': 'globe', '🚦': 'traffic', '⏸': 'pause', '⏹': 'stop',
  '⬇': 'download', '❤': 'heart',
};

export function svg(rows) {
  let r = '';
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (PAL[ch]) r += `<rect x='${x}' y='${y}' width='1' height='1' fill='${PAL[ch]}'/>`; }));
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' shape-rendering='crispEdges'>${r}</svg>`;
}
export function check() {
  const bad = [];
  for (const [k, rows] of Object.entries(ICONS)) {
    if (rows.length > 12) bad.push(`${k}: ${rows.length} rows`);
    rows.forEach((row, i) => { if ([...row].length !== 12) bad.push(`${k} row ${i}: ${[...row].length} cols "${row}"`); for (const ch of row) if (ch !== '.' && !PAL[ch]) bad.push(`${k} row ${i}: colour "${ch}"`); });
  }
  for (const [e, k] of Object.entries(EMOJI)) if (!ICONS[k]) bad.push(`emoji ${e} → missing icon ${k}`);
  return bad;
}
const uri = (s) => `url("data:image/svg+xml,${encodeURIComponent(s).replace(/'/g, '%27')}")`;
export function css() { return Object.entries(ICONS).map(([k, rows]) => `  .pxi-${k} { background-image: ${uri(svg(rows))}; }`).join('\n'); }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = check();
  if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
  const file = new URL('../widget.html', import.meta.url);
  let html = readFileSync(file, 'utf8');
  const put = (a, b, body) => { const i = html.indexOf(a), j = html.indexOf(b); if (i < 0 || j < i) throw new Error(`markers ${a} … ${b} not found`); html = html.slice(0, i + a.length) + '\n' + body + '\n' + html.slice(j); };
  put('/* pxi:css:start */', '  /* pxi:css:end */', css());
  put('// pxi:map:start', '// pxi:map:end', `const PXI_EMOJI = ${JSON.stringify(EMOJI)};`);
  writeFileSync(file, html);
  console.log(`${Object.keys(ICONS).length} icons, ${Object.keys(EMOJI).length} emoji → widget.html`);
}
