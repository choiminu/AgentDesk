// The parts a character is put together from. Every table here is data: add a row and it can be used in a spec.
// A spec names one entry from each table:
//
//   { skin: "fair", hair: { style: "short", color: "brown" }, hat: { kind: "cap", color: "#e0574f" } | null,
//     top: { kind: "collar", color: "#4f8fe0", sleeve: "long" }, bottom: { kind: "pants", color: "#3b4a6b" },
//     shoes: "#4a3b45", props: ["glasses"], accent: "#f2c14e" }

import { Rng } from "../core/math.js";

export const SKIN = { fair: "#f6d3b3", tan: "#e3ab7e", brown: "#b97a52", deep: "#8f5d40" };

export const HAIR_COLORS = {
  black: "#33303f", brown: "#6b4530", chestnut: "#9a5a34", blonde: "#e8c36a", red: "#c8553a",
  pink: "#ee8fb2", blue: "#5b8fd8", silver: "#c9ccd6", green: "#58b08a", purple: "#8a68c8",
};

// fringe: how the hair meets the forehead ("full" | "part" | "none"); side: the last cell row the hair covers
// beside the face (13 = ear-high ... 21 = long); top: something on the crown ("" | "bun" | "spiky" | "tuft" | "pony").
export const HAIR_STYLES = {
  short: { fringe: "full", side: 15, top: "" },
  bob: { fringe: "full", side: 19, top: "" },
  long: { fringe: "full", side: 21, top: "" },
  parted: { fringe: "part", side: 16, top: "" },
  longParted: { fringe: "part", side: 21, top: "" },
  crop: { fringe: "none", side: 13, top: "" },
  spiky: { fringe: "none", side: 13, top: "spiky" },
  bun: { fringe: "part", side: 16, top: "bun" },
  tuft: { fringe: "full", side: 16, top: "tuft" },
  ponytail: { fringe: "full", side: 14, top: "pony" },
};

export const HATS = ["cap", "beanie"];
/** What the upper body wears. */
export const TOPS = ["tee", "collar", "stripe", "overall", "hoodie", "vest", "suit"];
export const SLEEVES = ["long", "short"];
/** What the legs wear. */
export const BOTTOMS = ["pants", "shorts", "skirt"];
/** Things worn all the time. (Things held — paper, umbrella, a stack of documents — come with a pose.) */
export const PROPS = ["glasses", "headphones", "scarf", "badge"];

const DEFAULTS = {
  skin: "fair", hair: { style: "short", color: "brown" }, hat: null,
  top: { kind: "tee", color: "#4f8fe0", sleeve: "long" }, bottom: { kind: "pants", color: "#3b4a6b" },
  shoes: "#4a3b45", props: [], accent: "#f2c14e",
};

const need = (ok, what) => { if (!ok) throw new Error(`character: ${what}`); };

/** Fill in a spec's defaults and reject names that are not in the tables. Returns a new, complete spec. */
export function character(spec = {}) {
  const c = {
    ...DEFAULTS, ...spec,
    hair: { ...DEFAULTS.hair, ...spec.hair },
    top: { ...DEFAULTS.top, ...spec.top },
    bottom: { ...DEFAULTS.bottom, ...spec.bottom },
    hat: spec.hat ? { color: "#e0574f", ...spec.hat } : null,
    props: [...(spec.props ?? [])],
  };
  need(c.skin in SKIN, `unknown skin "${c.skin}"`);
  need(c.hair.style in HAIR_STYLES, `unknown hair style "${c.hair.style}"`);
  need(c.hair.color in HAIR_COLORS || /^#[0-9a-f]{6}$/i.test(c.hair.color), `unknown hair color "${c.hair.color}"`);
  need(!c.hat || HATS.includes(c.hat.kind), `unknown hat "${c.hat?.kind}"`);
  need(TOPS.includes(c.top.kind), `unknown top "${c.top.kind}"`);
  need(SLEEVES.includes(c.top.sleeve), `unknown sleeve "${c.top.sleeve}"`);
  need(BOTTOMS.includes(c.bottom.kind), `unknown bottom "${c.bottom.kind}"`);
  for (const p of c.props) need(PROPS.includes(p), `unknown prop "${p}"`);
  return c;
}

const TOP_COLORS = ["#4f8fe0", "#ef8a5b", "#e86f9a", "#47b58a", "#f2c14e", "#f4f1ea", "#5b6ee0", "#8fd0c8", "#9a6fd8", "#f08a3c", "#5aa9e6", "#ef6f6f"];
const BOTTOM_COLORS = ["#3b4a6b", "#4a4458", "#5a4a7a", "#3f4a52", "#5b4636", "#44475c", "#39506a"];
const HAT_COLORS = ["#e0574f", "#f2c14e", "#5b8fd8", "#58b08a"];

/** A character put together from a seed (a number or a string): the same seed is always the same person. */
export function randomCharacter(seed) {
  const r = new Rng(seed), top = r.pick(TOP_COLORS);
  return character({
    skin: r.pick(Object.keys(SKIN)),
    hair: { style: r.pick(Object.keys(HAIR_STYLES)), color: r.pick(Object.keys(HAIR_COLORS)) },
    hat: r.chance(0.2) ? { kind: r.pick(HATS), color: r.pick(HAT_COLORS) } : null,
    top: { kind: r.pick(TOPS), color: top, sleeve: r.chance(0.3) ? "short" : "long" },
    bottom: { kind: r.chance(0.7) ? "pants" : r.pick(BOTTOMS), color: r.pick(BOTTOM_COLORS) },
    props: r.chance(0.35) ? [r.pick(PROPS)] : [],
    accent: r.pick(HAT_COLORS),
  });
}

/** Ready-made people, named after what they look like. No two share both a hair color and a top color. */
export const PRESETS = {
  sky: { skin: "fair", hair: { style: "short", color: "brown" }, top: { kind: "collar", color: "#4f8fe0" }, bottom: { color: "#3b4a6b" } },
  coral: { skin: "tan", hair: { style: "bob", color: "black" }, top: { kind: "hoodie", color: "#ef8a5b" }, bottom: { color: "#4a4458" } },
  rose: { skin: "fair", hair: { style: "long", color: "blonde" }, top: { kind: "stripe", color: "#e86f9a", sleeve: "short" }, bottom: { kind: "skirt", color: "#5a4a7a" } },
  mint: { skin: "brown", hair: { style: "spiky", color: "black" }, top: { kind: "tee", color: "#47b58a", sleeve: "short" }, bottom: { kind: "shorts", color: "#3f4a52" } },
  sun: { skin: "fair", hair: { style: "bun", color: "red" }, top: { kind: "overall", color: "#f2c14e" }, bottom: { color: "#5b4636" }, props: ["glasses"] },
  cloud: { skin: "deep", hair: { style: "crop", color: "black" }, top: { kind: "suit", color: "#5c6684" }, bottom: { color: "#3c4a66" }, accent: "#e0574f" },
  berry: { skin: "tan", hair: { style: "short", color: "chestnut" }, hat: { kind: "cap", color: "#e0574f" }, top: { kind: "vest", color: "#5b6ee0" }, bottom: { color: "#44475c" } },
  peach: { skin: "fair", hair: { style: "bob", color: "pink" }, top: { kind: "stripe", color: "#8fd0c8" }, bottom: { kind: "skirt", color: "#5c5470" }, accent: "#5b8fd8" },
  moss: { skin: "brown", hair: { style: "parted", color: "silver" }, top: { kind: "collar", color: "#8a9a4e" }, bottom: { color: "#3f3a52" }, props: ["badge"] },
  amber: { skin: "deep", hair: { style: "tuft", color: "blue" }, hat: null, top: { kind: "hoodie", color: "#f08a3c" }, bottom: { color: "#39506a" }, props: ["scarf"], accent: "#8fd0c8" },
  pine: { skin: "tan", hair: { style: "crop", color: "green" }, hat: { kind: "beanie", color: "#f2c14e" }, top: { kind: "overall", color: "#f4f1ea" }, bottom: { color: "#4a6fa8" }, accent: "#58b08a" },
  lilac: { skin: "fair", hair: { style: "ponytail", color: "purple" }, top: { kind: "tee", color: "#ef6f6f" }, bottom: { color: "#5c5470" }, props: ["headphones"], accent: "#f2c14e" },
};
