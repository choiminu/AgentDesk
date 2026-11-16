// Contact sheets: drawings laid out in a grid, enlarged and labelled, on a backdrop that shows what is
// transparent. This is how a drawing gets looked at. The layout follows pixelfx's contact sheet
// (tools/lib/fxlib.mjs, MIT) — see ../../NOTICE.md.

import { Canvas, hex } from "../../core/index.js";

const BG = hex("#f4efe6"), CHECK_A = hex("#e9e3d8"), CHECK_B = hex("#dfd8cb"), LABEL = hex("#6d6478"), TITLE = hex("#352b3d");

/** A checkerboard under a w x h cell so transparent pixels are visible. */
function backdrop(sheet, x, y, w, h, k, bg) {
  if (bg) return sheet.rect(x, y, w, h, hex(bg));
  const s = Math.max(2, k);   // one check per source pixel
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) sheet.set(x + i, y + j, (((i / s) | 0) + ((j / s) | 0)) & 1 ? CHECK_A : CHECK_B);
}

/**
 * Lay items out in rows. items: [{ label, canvas, zoom?, bg? (a color instead of the checkerboard), br? (start a
 * new row after this one) }]. opts: { title, zoom (default 4), width (wrap at, px), pad }.
 */
export function contactSheet(items, { title = "", zoom = 4, width = 1400, pad = 10 } = {}) {
  const cells = items.map((it) => { const k = it.zoom ?? zoom; return { ...it, k, cw: Math.max(it.canvas.w * k, Canvas.textSize(it.label ?? "", 2)[0]), ch: it.canvas.h * k }; });
  const rows = [[]];
  let x = pad;
  for (const c of cells) {
    let row = rows[rows.length - 1];
    if (row.length && x + c.cw + pad > width) { rows.push((row = [])); x = pad; }
    row.push(c);
    x += c.cw + pad;
    if (c.br) { rows.push([]); x = pad; }
  }
  const used = rows.filter((r) => r.length), head = title ? 34 : pad, labelH = 16;
  const W = Math.max(...used.map((r) => r.reduce((s, c) => s + c.cw + pad, pad)), Canvas.textSize(title, 3)[0] + pad * 2);
  const H = head + used.reduce((s, r) => s + Math.max(...r.map((c) => c.ch)) + labelH + pad, 0);
  const sheet = new Canvas(W, H, BG);
  if (title) sheet.text(title, pad, 10, TITLE, { scale: 3 });
  let y = head;
  for (const r of used) {
    let cx = pad;
    const rh = Math.max(...r.map((c) => c.ch));
    for (const c of r) {
      sheet.text(c.label ?? "", cx, y, LABEL, { scale: 2 });
      backdrop(sheet, cx, y + labelH, c.canvas.w * c.k, c.ch, c.k, c.bg);
      sheet.blit(c.canvas.scaled(c.k), cx, y + labelH);
      cx += c.cw + pad;
    }
    y += rh + labelH + pad;
  }
  return sheet;
}

/** Cut a sheet of equal frames into canvases, row by row. */
export function frames(sheet, fw, fh) {
  const out = [];
  for (let y = 0; y + fh <= sheet.h; y += fh) for (let x = 0; x + fw <= sheet.w; x += fw) out.push(sheet.crop(x, y, fw, fh));
  return out;
}
