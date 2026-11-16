// Draws one 16 x 32 character frame from a spec (char/parts.js) and a pose (char/poses.js), layer by layer:
// legs, body, arms, head, hair, hat, things worn, things held, then one outline around the lot. A round head with
// dot eyes on a small body, to sit beside the office's pale floors and soft furniture.
//
// The proportions and the base seven poses follow this repository's own scripts/office-town.mjs, so sheets made
// here drop in where those are used.

import { Canvas } from "../core/canvas.js";
import { hex, mix, shade, tint, INK, WHITE } from "../core/color.js";
import { SKIN, HAIR_COLORS, HAIR_STYLES, character } from "./parts.js";
import { POSES, FRAME, VIEWS, BASE_POSES, ACTIONS } from "./poses.js";

const SEAT = 3;   // a seated body sits this much lower

function colors(spec) {
  const skin = hex(SKIN[spec.skin]), hair = hex(HAIR_COLORS[spec.hair.color] ?? spec.hair.color);
  const top = hex(spec.top.color), bot = hex(spec.bottom.color), acc = hex(spec.accent), hat = spec.hat ? hex(spec.hat.color) : 0;
  return {
    skin, skinD: shade(skin, 0.18), blush: mix(skin, hex("#f07882"), 0.35),
    hair, hairD: shade(hair, 0.25), hairL: tint(hair, 0.3),
    top, topD: shade(top, 0.2), topL: tint(top, 0.5),
    bot, botD: shade(bot, 0.25), shoe: hex(spec.shoes),
    acc, accD: shade(acc, 0.22), accL: tint(acc, 0.4), hat, hatD: hat && shade(hat, 0.2),
    white: WHITE, paper: hex("#d9dde6"), paperD: hex("#aab2c2"), lens: hex("#bfe3ff"), metal: hex("#8790a8"), ink: INK,
  };
}

/** Draw one frame with its top-left at (ox, oy). view: "down" | "up" | "side"; pose: a name from POSES or a pose object. */
export function drawChar(g, ox, oy, spec, view = "down", pose = "stand") {
  spec = character(spec);
  const p = typeof pose === "string" ? POSES[pose] : pose;
  if (!p) throw new Error(`character: unknown pose "${pose}"`);
  if (!VIEWS.includes(view)) throw new Error(`character: unknown view "${view}"`);
  const k = {
    spec, pose: p, view, c: colors(spec), hairStyle: HAIR_STYLES[spec.hair.style],
    s: p.seat ? SEAT : p.dy ?? 0,
    P: (x, y, col) => { if (x >= 0 && x < FRAME.w && y >= 0 && y < FRAME.h) g.set(ox + x, oy + y, col); },
    R: (y, x0, x1, col) => { for (let x = x0; x <= x1; x++) k.P(x, y, col); },
    has: (prop) => spec.props.includes(prop),
  };
  if (view === "side") side(k); else front(k, view === "up");
  g.outline(INK, ox, oy, FRAME.w, FRAME.h);
  return g;
}

// ── shared pieces ──

// the color of the i-th pixel of an arm, counted from the shoulder
const sleeve = (k, i) => (k.spec.top.sleeve === "short" && i >= 2 ? k.c.skin : k.c.topD);
// the color of the i-th row of a leg, counted from the hip
const legColor = (k, i) => (k.spec.bottom.kind === "pants" || (k.spec.bottom.kind === "shorts" && i === 0) ? k.c.bot : k.c.skin);
const legShade = (k, i) => (legColor(k, i) === k.c.bot ? k.c.botD : k.c.skinD);

// The umbrella's canopy: a dome whose rows are 2 * hw[i] px wide, centred between columns cx and cx + 1. It sits
// low, right on the hair, so the whole of it stays below the top 4 px that the dock's 16 x 28 window cuts off.
function canopy(k, cx, top, hw = [3, 5, 7, 7, 7]) {
  const { P, c } = k;
  hw.forEach((w, i) => {
    for (let x = cx + 1 - w; x <= cx + w; x++) {
      const u = (x - (cx + 0.5)) / hw[hw.length - 1];                 // -1 left rim .. 1 right rim
      const last = i === hw.length - 1;
      if (last && ((x - (cx + 1 - w)) % 4 === 3)) continue;            // a scalloped hem
      P(x, top + i, last ? c.accD : u < -0.35 ? c.accL : u > 0.4 ? c.accD : c.acc);
    }
  });
}

// A stack of documents: sheets on a folder, w px wide and 4 px tall, its top-left at (x, y).
function stack(k, x, y, w) {
  const { P, R, c } = k;
  R(y, x, x + w - 1, c.white);
  R(y + 1, x, x + w - 1, c.white); R(y + 1, x + 1, x + w - 2, c.paperD);
  R(y + 2, x, x + w - 1, c.paper);
  R(y + 3, x, x + w - 1, c.acc); P(x + w - 1, y + 3, c.accD);
}

function tops(k, x0, x1) {
  const { P, R, c, s, view, spec } = k, kind = spec.top.kind, face = view === "down", sideV = view === "side";
  if (kind === "collar") { if (face) { P(7, 20 + s, c.white); P(8, 20 + s, c.white); } else if (sideV) P(10, 20 + s, c.white); }
  else if (kind === "stripe") { R(22 + s, x0, x1, c.topL); R(24 + s, x0, x1, c.topL); }
  else if (kind === "overall") {
    for (let y = 23 + s; y <= 25 + s; y++) R(y, x0, x1, y === 25 + s ? c.botD : c.bot);
    if (sideV) { P(8, 21 + s, c.bot); P(8, 22 + s, c.bot); }
    else for (const x of [6, 9]) { P(x, 21 + s, c.bot); P(x, 22 + s, c.bot); }
  } else if (kind === "hoodie") {
    if (face) { R(24 + s, 6, 9, c.topD); P(7, 20 + s, c.topL); P(8, 20 + s, c.topL); P(7, 21 + s, c.topL); }
    else if (sideV) { P(6, 20 + s, c.topD); P(6, 21 + s, c.topD); P(7, 20 + s, c.topD); R(24 + s, 8, 10, c.topD); }
    else { R(20 + s, 6, 9, c.topD); R(21 + s, 6, 9, c.topD); R(22 + s, 7, 8, c.topD); }
  } else if (kind === "vest") {
    if (face) for (let y = 20 + s; y <= 23 + s; y++) R(y, 7, 8, y === 23 + s ? c.paper : c.white);
    else if (sideV) for (let y = 20 + s; y <= 23 + s; y++) P(10, y, c.white);
  } else if (kind === "suit") {
    if (face) { P(7, 20 + s, c.white); P(8, 20 + s, c.white); P(7, 21 + s, c.acc); P(8, 21 + s, c.acc); P(7, 22 + s, c.accD); P(6, 20 + s, c.topD); P(9, 20 + s, c.topD); }
    else if (sideV) { P(10, 20 + s, c.white); P(10, 21 + s, c.acc); }
    else R(20 + s, 6, 9, c.topD);
  }
}

function hat(k, y0) {
  const { P, R, c, view, spec, hairStyle } = k, x0 = view === "side" ? 4 : 3, x1 = 12, top = hairStyle.top;
  if (!spec.hat) {
    if (top === "bun") { R(y0 + 8, 6, 9, c.hair); R(y0 + 9, 6, 9, c.hair); P(6, y0 + 8, c.hairD); P(8, y0 + 8, c.hairL); }
    else if (top === "spiky") for (const x of [4, 6, 8, 10]) { P(x, y0 + 9, c.hair); P(x + 1, y0 + 9, c.hair); P(x, y0 + 8, c.hair); }
    else if (top === "tuft") { P(8, y0 + 9, c.hair); P(9, y0 + 8, c.hair); P(9, y0 + 9, c.hair); }
    return;
  }
  R(y0 + 9, x0 + 2, x1 - 2, c.hat); R(y0 + 10, x0 + 1, x1 - 1, c.hat); R(y0 + 11, x0, x1, c.hat); R(y0 + 12, x0, x1, c.hatD);
  P(x0 + 3, y0 + 10, tint(c.hat, 0.35)); P(x0 + 4, y0 + 10, tint(c.hat, 0.35));
  if (spec.hat.kind === "cap") { if (view === "down") R(y0 + 13, 2, 13, c.hatD); else if (view === "side") R(y0 + 12, 11, 14, c.hatD); }
  else { P(7, y0 + 8, c.hatD); P(8, y0 + 8, c.hatD); }   // a beanie's bobble
}

// ── facing the viewer, or away ──
function front(k, back) {
  const { P, R, c, s, pose, spec, hairStyle: hs } = k, arms = pose.arms ?? "swing", beat = pose.beat ?? 0;
  const far = (x) => (back ? 15 - x : x);   // the umbrella hand is the same hand from both sides

  if (arms === "umbrella" && back) for (let y = 10; y <= 22; y++) P(far(12), y, c.metal);   // seen from behind, the shaft is beyond the head

  // legs
  if (pose.seat) { R(29, 5, 6, c.shoe); R(29, 9, 10, c.shoe); }
  else {
    const air = s < 0, top = 26 + s, len = air ? (pose.legs === "tuck" ? 2 : 3) : 3 - s, wide = pose.legs === "wide" ? 1 : 0;
    const leg = (x0, x1, up, inner) => {
      const n = Math.max(0, len - up);
      for (let i = 0; i < n; i++) { R(top + i, x0, x1, legColor(k, i)); if (inner !== null) P(inner, top + i, legShade(k, i)); }
      R(top + n, x0, x1, c.shoe);
    };
    leg(5 - wide, 7 - wide, pose.step === 1 ? 1 : 0, 7 - wide);
    leg(8 + wide, 10 + wide, pose.step === 2 ? 1 : 0, null);
  }

  // body
  for (let y = 20 + s; y <= 25 + s; y++) R(y, 5, 10, y === 25 + s ? c.topD : c.top);
  tops(k, 5, 10);
  if (spec.bottom.kind === "skirt") { R(25 + s, 5, 10, c.bot); if (!pose.seat) R(26 + s, 4, 11, c.botD); }
  if (k.has("badge") && !back) { P(8, 21 + s, c.paperD); P(8, 22 + s, c.white); P(9, 22 + s, c.white); P(8, 23 + s, c.white); P(9, 23 + s, c.accD); }

  // arms
  const arm = (x, from, n, hand = true) => { for (let i = 0; i < n; i++) P(x, from + i, sleeve(k, i + (from - 20 - s))); if (hand) P(x, from + n, c.skin); };
  if (arms === "type") {
    arm(4, 21 + s, 3, false); arm(11, 21 + s, 3, false);
    if (!back) { P(3, 24 + s - (1 - beat), sleeve(k, 3)); P(3, 25 + s - (1 - beat), c.skin); P(12, 24 + s - beat, sleeve(k, 3)); P(12, 25 + s - beat, c.skin); }
    else { P(4, 24 + s, sleeve(k, 3)); P(11, 24 + s, sleeve(k, 3)); }
  } else if (arms === "read") {
    arm(4, 21 + s, 4, false); arm(11, 21 + s, 4, false);
    if (!back) {
      const y = 23 + s - beat;   // five rows that end one short of the frame, so the outline fits under them
      for (let j = 0; j < 5; j++) R(y + j, 5, 10, c.white);
      R(y + 1, 6, 9, c.paperD); R(y + 3, 6, 8, c.paperD);
      P(4, y + 2, c.skin); P(11, y + 2, c.skin);
    }
  } else if (arms === "umbrella") {
    arm(far(4), 20 + s, 4);
    P(far(11), 20 + s, sleeve(k, 0)); P(far(11), 21 + s, sleeve(k, 1)); P(far(12), 21 + s, c.skin);
  } else if (arms === "carry") {
    arm(4, 20 + s, 3, false); arm(11, 20 + s, 3, false);
    if (!back) { stack(k, 4, 21 + s - beat, 8); P(4, 24 + s - beat, c.skin); P(11, 24 + s - beat, c.skin); }
    else { P(3, 22 + s, sleeve(k, 2)); P(12, 22 + s, sleeve(k, 2)); }   // elbows out
  } else if (arms === "up") {
    for (const m of [(x) => x, (x) => 15 - x]) { P(m(4), 20 + s, sleeve(k, 0)); P(m(3), 19 + s, sleeve(k, 1)); P(m(2), 18 + s, sleeve(k, 2)); P(m(2), 17 + s, c.skin); }
  } else if (arms === "back") {
    // wound up for a jump: elbows out wide, fists by the hips
    for (const m of [(x) => x, (x) => 15 - x]) { P(m(4), 20 + s, sleeve(k, 0)); P(m(3), 20 + s, sleeve(k, 0)); P(m(2), 21 + s, sleeve(k, 1)); P(m(2), 22 + s, sleeve(k, 2)); P(m(3), 23 + s, sleeve(k, 3)); P(m(4), 24 + s, c.skin); }
  } else if (arms === "out") {
    for (const m of [(x) => x, (x) => 15 - x]) { P(m(4), 20 + s, sleeve(k, 0)); P(m(3), 21 + s, sleeve(k, 1)); P(m(2), 22 + s, sleeve(k, 2)); P(m(1), 22 + s, c.skin); }
  } else {
    const lUp = pose.step === 2 ? 1 : 0, rUp = pose.step === 1 ? 1 : 0;   // an arm swings with the other leg
    arm(4, 20 + s, 4 - lUp); arm(11, 20 + s, 4 - rUp);
  }
  if (k.has("scarf")) { R(20 + s, 4, 11, c.acc); if (!back) { P(9, 21 + s, c.acc); P(9, 22 + s, c.accD); } else { P(6, 21 + s, c.acc); P(6, 22 + s, c.accD); } }

  // head
  const headRow = (y, col) => { const e = y === 11 + s || y === 19 + s; R(y, e ? 4 : 3, e ? 11 : 12, col); };
  for (let y = 11 + s; y <= 19 + s; y++) headRow(y, c.skin);
  R(19 + s, 4, 11, c.skinD);
  if (!back) {
    for (const x of [5, 10]) { P(x, 15 + s, c.ink); P(x, 16 + s, c.ink); }
    P(4, 17 + s, c.blush); P(11, 17 + s, c.blush);
    if (pose.glasses || k.has("glasses")) { for (const x of [4, 6, 7, 8, 9, 11]) P(x, 15 + s, c.ink); P(5, 15 + s, c.lens); P(10, 15 + s, c.lens); }
    // hair
    R(10 + s, 4, 11, c.hair); R(11 + s, 3, 12, c.hair); R(12 + s, 3, 12, c.hair);
    if (hs.fringe === "full") { R(13 + s, 3, 12, c.hair); for (const x of [3, 6, 7, 8, 12]) P(x, 14 + s, c.hair); }
    else if (hs.fringe === "part") { R(13 + s, 3, 6, c.hair); R(13 + s, 10, 12, c.hair); for (const x of [3, 4, 12]) P(x, 14 + s, c.hair); }
    else { P(3, 13 + s, c.hair); P(12, 13 + s, c.hair); }
    for (let y = 13 + s; y <= Math.min(hs.side, 19) + s; y++) { P(3, y, c.hair); P(12, y, c.hair); }
    if (hs.side > 19) for (let y = 14 + s; y <= hs.side + s; y++) {
      const low = y >= hs.side - 1 + s;
      P(2, y, low ? c.hairD : c.hair); P(13, y, low ? c.hairD : c.hair);
      if (y >= 20 + s) { P(3, y, c.hairD); P(12, y, c.hairD); }
    }
    R(11 + s, 5, 7, c.hairL);
  } else {
    const end = Math.min(Math.max(hs.side + 2, 17), 19) + s;
    R(10 + s, 4, 11, c.hair);
    for (let y = 11 + s; y <= end; y++) headRow(y, c.hair);
    headRow(end, c.hairD);
    if (hs.side > 19) for (let y = 14 + s; y <= hs.side + s; y++) R(y, 2, 13, y >= hs.side - 1 + s ? c.hairD : c.hair);
    if (hs.top === "pony") { for (let y = 15 + s; y <= 22 + s; y++) R(y, 7, 8, y >= 21 + s ? c.hairD : c.hair); P(7, 14 + s, c.acc); P(8, 14 + s, c.acc); }
    R(12 + s, 5, 7, c.hairL);
  }
  hat(k, s);
  if (k.has("headphones")) {   // a band over the crown, a cup on each ear
    R(9 + s, 5, 10, c.metal); P(4, 10 + s, c.metal); P(11, 10 + s, c.metal); P(3, 11 + s, c.metal); P(12, 11 + s, c.metal);
    for (const x of [2, 13]) { P(x, 14 + s, c.acc); P(x, 15 + s, c.acc); P(x, 16 + s, c.accD); }
  }
  if (arms === "umbrella") {
    if (!back) { for (let y = 10; y <= 22; y++) P(12, y, c.metal); P(12, 21 + s, c.skin); }   // from the front the shaft shows beside the face: without it the canopy reads as a hat
    canopy(k, 7, 5 + beat);
  }
}

// ── facing right ──
function side(k) {
  const { P, R, c, s, pose, spec, hairStyle: hs } = k, arms = pose.arms ?? "swing", beat = pose.beat ?? 0;

  // legs first (the body overlaps them)
  if (pose.seat) { R(29, 7, 11, legColor(k, 0)); R(30, 10, 12, c.shoe); }
  else if (pose.step || pose.legs === "wide") {   // a stride: one leg forward, one back; the two steps swap which foot is planted
    const a = pose.step !== 2;
    for (let y = 26; y <= 27; y++) { R(y, 4, 6, legShade(k, y - 26)); R(y, 8, 10, legColor(k, y - 26)); }
    R(28, a ? 3 : 4, a ? 5 : 6, a ? c.shoe : legShade(k, 2)); R(28, 9, 11, a ? legColor(k, 2) : c.shoe);
    if (a) R(29, 9, 12, c.shoe); else R(29, 3, 6, c.shoe);
  } else {
    const air = s < 0, top = 26 + s, tuck = pose.legs === "tuck", len = air ? (tuck ? 2 : 3) : 3 - s, f = tuck ? 1 : 0;
    for (let i = 0; i < len; i++) R(top + i, 6 + f, 9 + f, i === len - 1 && !air ? legShade(k, i) : legColor(k, i));
    R(top + len, 6 + f, 10 + f, c.shoe);
  }
  // body
  for (let y = 20 + s; y <= 25 + s; y++) R(y, 6, 10, y === 25 + s ? c.topD : c.top);
  tops(k, 6, 10);
  if (spec.bottom.kind === "skirt") { R(25 + s, 6, 10, c.bot); if (!pose.seat) R(26 + s, 5, 11, c.botD); }
  if (k.has("scarf")) { R(20 + s, 5, 11, c.acc); P(5, 21 + s, c.acc); P(5, 22 + s, c.accD); }
  // head
  const headRow = (y, col) => { const e = y === 11 + s || y === 19 + s; R(y, e ? 5 : 4, e ? 11 : 12, col); };
  for (let y = 11 + s; y <= 19 + s; y++) headRow(y, c.skin);
  R(19 + s, 5, 11, c.skinD);
  P(10, 15 + s, c.ink); P(10, 16 + s, c.ink);
  P(11, 17 + s, c.blush);
  // hair: the top and the back of the head
  R(10 + s, 5, 11, c.hair); R(11 + s, 4, 12, c.hair); R(12 + s, 4, 12, c.hair);
  if (hs.fringe !== "none") R(13 + s, 4, 12, c.hair); else R(13 + s, 4, 8, c.hair);
  for (let y = 13 + s; y <= Math.min(hs.side + 2, 22) + s; y++) R(y, y > 19 + s ? 5 : 4, 7, y >= hs.side + 1 + s ? c.hairD : c.hair);
  if (hs.top === "pony") { P(4, 14 + s, c.acc); for (let y = 14 + s; y <= 20 + s; y++) { P(3, y, y >= 19 + s ? c.hairD : c.hair); if (y > 14 + s && y < 20 + s) P(2, y, c.hair); } }
  R(11 + s, 6, 8, c.hairL);
  hat(k, s);
  if (pose.glasses || k.has("glasses")) { P(10, 15 + s, c.lens); P(11, 15 + s, c.ink); P(9, 15 + s, c.ink); P(8, 15 + s, c.ink); }
  if (k.has("headphones")) {   // the band comes down over the hair to a cup on the ear: a dark rim round a colored middle
    R(9 + s, 6, 8, c.metal); for (let y = 10 + s; y <= 12 + s; y++) P(6, y, c.metal);
    for (let y = 13 + s; y <= 16 + s; y++) R(y, 5, 7, c.metal);
    P(6, 14 + s, c.acc); P(6, 15 + s, c.acc);
  }
  if (k.has("badge")) { P(9, 22 + s, c.white); P(9, 23 + s, c.white); }
  // the near arm
  if (arms === "type") { const y = 24 + beat + s; R(y, 8, 11, sleeve(k, 0)); P(12, y, c.skin); }
  else if (arms === "read") {
    const y = 23 - beat + s;
    R(y + 1, 8, 11, sleeve(k, 0)); P(12, y + 1, c.skin);
    for (let j = 0; j < 5; j++) { P(13, y - 2 + j, c.white); P(14, y - 2 + j, c.paper); }
  } else if (arms === "umbrella") {
    // held close: the shaft runs up past the cheek to the middle of a canopy that sits a little forward
    for (let y = 10; y <= 23; y++) P(11, y, c.metal);
    P(8, 20 + s, sleeve(k, 0)); P(8, 21 + s, sleeve(k, 0)); R(22 + s, 8, 10, sleeve(k, 1)); P(11, 22 + s, c.skin); P(12, 22 + s, c.skin);
    canopy(k, 9, 5 + beat, [3, 4, 5, 5, 5]);
  } else if (arms === "carry") {
    stack(k, 11, 20 + s - beat, 3);
    P(8, 20 + s, sleeve(k, 0)); P(8, 21 + s, sleeve(k, 0)); P(8, 22 + s, sleeve(k, 1)); R(23 + s, 8, 10, sleeve(k, 2)); P(11, 24 + s - beat, c.skin); P(12, 24 + s - beat, c.skin);
  } else if (arms === "up") {   // up past the face, so it reads as an arm and not as a nose
    P(9, 21 + s, sleeve(k, 0)); P(10, 21 + s, sleeve(k, 0)); P(11, 20 + s, sleeve(k, 1)); P(12, 19 + s, sleeve(k, 1));
    P(13, 18 + s, sleeve(k, 2)); P(13, 17 + s, sleeve(k, 2)); P(13, 16 + s, sleeve(k, 3)); P(13, 15 + s, c.skin);
  }
  else if (arms === "back") { P(6, 20 + s, sleeve(k, 0)); P(5, 21 + s, sleeve(k, 1)); P(4, 21 + s, sleeve(k, 1)); P(3, 22 + s, sleeve(k, 2)); P(2, 23 + s, sleeve(k, 3)); P(2, 24 + s, c.skin); }   // swung back behind
  else if (arms === "out") { P(9, 21 + s, sleeve(k, 0)); P(10, 22 + s, sleeve(k, 1)); P(11, 23 + s, sleeve(k, 2)); P(12, 23 + s, c.skin); }
  else {
    const sw = pose.step === 1 ? 1 : pose.step === 2 ? -1 : 0;
    for (let y = 20; y <= 23; y++) P(8 + (y > 21 ? sw : 0), y + s, sleeve(k, y - 20));
    P(8 + sw, 24 + s, c.skin);
  }
}

// ── sheets ──

/** One frame as its own 16 x 32 canvas. */
export function frame(spec, view = "down", pose = "stand") {
  return drawChar(new Canvas(FRAME.w, FRAME.h), 0, 0, spec, view, pose);
}
/** A sheet of the given poses: one column per pose, one row per view. */
export function poseSheet(spec, poses) {
  const g = new Canvas(poses.length * FRAME.w, VIEWS.length * FRAME.h);
  VIEWS.forEach((v, r) => poses.forEach((p, f) => drawChar(g, f * FRAME.w, r * FRAME.h, spec, v, p)));
  return g;
}
/** The base sheet, 112 x 96: the layout the office already loads. */
export const baseSheet = (spec) => poseSheet(spec, BASE_POSES);
/** An extra action's sheet ("umbrella" | "jump" | "carry"): (frames x 16) x 96. */
export function actionSheet(spec, action) {
  if (!ACTIONS[action]) throw new Error(`character: unknown action "${action}"`);
  return poseSheet(spec, ACTIONS[action]);
}
