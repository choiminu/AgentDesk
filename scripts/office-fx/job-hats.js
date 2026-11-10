// AgentDesk dock: the job hats, one per frame (not an animation: widget.html shows one frame, picked by the job) —
// 16 x 8 each, sitting on a 16 px wide character's head, the brim on the bottom row. In order: hacker (hood with a
// green visor), scholar (mortarboard), smith (hard hat), scribe (beret with a quill), explorer (safari hat),
// commander (crown), mage (pointed hat with a star), operator (headset). Baked by scripts/office-fx.mjs.
import { hex } from "../../core/index.js";

export const meta = {
  name: "Dock job hats",
  desc: "Eight 16 x 8 hats, one per frame, for the dock characters' jobs.",
  tags: ["office", "dock", "hat", "sheet"],
  size: [16, 8],
  origin: [0, 0],
  duration: 8,
  loop: true,
  fps: 1,
  bg: "dark",
  options: {},
};

// letters index each hat's palette; "." is empty
const HATS = [
  { pal: { a: "#1c2530", b: "#2f3d4d", g: "#46e08a", w: "#c8ffe0" }, rows: [
    "................", "....aaaaaaa.....", "...abbbbbbba....", "..abbbbbbbbba...", "..abbbbbbbbba...", "..aggwggggwga...", "..abbbbbbbbba...", "................"] },
  { pal: { a: "#1b1b2a", b: "#34344d", y: "#ffd24a", o: "#d99a1a" }, rows: [
    "................", "................", ".......bb.......", "....bbbbbbbb....", ".bbbbbbbbbbbbby.", "...aaaaaaaaa..y.", "....aaaaaaa...o.", "................"] },
  { pal: { a: "#b8860b", y: "#ffcf33", w: "#fff3b0", d: "#7a5a00" }, rows: [
    "................", "................", ".....yyyyy......", "....ywwyyyy.....", "...yywyyyyyy....", "...yyyyyyyyy....", "..aaaaaaaaaaa...", "..d.........d..."] },
  { pal: { a: "#5a1f2e", r: "#a8324a", p: "#d9607a", w: "#ffffff", q: "#cfd8e8" }, rows: [
    "............w...", "...........wq...", "....rrrrr.wq....", "..rrpprrrrq.....", ".rrprrrrrrrr....", ".rrrrrrrrrrr....", "..aaaaaaaaa.....", "................"] },
  { pal: { a: "#6b5330", t: "#c9a86a", l: "#ecd9a8", b: "#4a3a20" }, rows: [
    "................", "................", ".....ttttt......", "....tllttttt....", "....ttttttt.....", "....bbbbbbb.....", ".aaatttttttaaa..", "..aaaaaaaaaaa..."] },
  { pal: { y: "#ffcf33", o: "#c98a12", w: "#fff6c8", r: "#e0405a", c: "#5fd6ff" }, rows: [
    "................", "................", "...y...y...y....", "...yy.yyy.yy....", "...yyyyyyyyy....", "...yrywycyry....", "...ooooooooo....", "................"] },
  { pal: { a: "#2c1a5c", p: "#5a3cc0", l: "#8f74f0", y: "#ffe27a" }, rows: [
    ".........pl.....", "........ppl.....", ".......pppl.....", "......ppypp.....", ".....pppppppp...", "....ppppppppp...", ".aaaaaaaaaaaaaa.", "................"] },
  { pal: { a: "#22262e", g: "#5a6474", l: "#9aa6b8", r: "#ff5f8f" }, rows: [
    "................", "....gggggggg....", "...gl......lg...", "..gl........lg..", "..g..........g..", ".aa..........aa.", ".aa..........aal", ".aa..........a.r"] },
];

export function draw(p, t) {
  const h = HATS[Math.min(HATS.length - 1, Math.max(0, Math.round(t)))];
  h.rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== ".") p.px(x, y, hex(h.pal[ch])); }));
}
