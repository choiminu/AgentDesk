// Poses are data. A pose says where the body is and what the limbs do; char/draw.js turns it into pixels for
// each of the three views. Fields (all optional):
//
//   seat   sits: the body is 3 px lower and the legs are tucked away
//   dy     body offset in px: positive crouches (the feet stay put), negative is in the air (the feet come along)
//   step   1 or 2: which foot is lifted in a walk
//   legs   "tuck" (knees up, in the air) | "wide" (feet apart, a landing)
//   arms   "swing" (default) | "type" | "read" | "umbrella" | "carry" | "up" | "back" | "out"
//   beat   0 or 1: the small alternating move of that arm pose (which hand taps, the prop bobbing)
//   glasses  reading glasses for this pose

export const POSES = {
  stand: {},
  walkA: { step: 1 },
  walkB: { step: 2 },
  typeA: { seat: true, arms: "type", beat: 0 },
  typeB: { seat: true, arms: "type", beat: 1 },
  readA: { seat: true, arms: "read", beat: 0, glasses: true },
  readB: { seat: true, arms: "read", beat: 1, glasses: true },
  // under an umbrella, walking: the canopy bobs with the step
  umbrellaA: { step: 1, arms: "umbrella", beat: 0 },
  umbrellaB: { step: 2, arms: "umbrella", beat: 1 },
  // a jump for joy: crouch, launch, peak, land
  jumpA: { dy: 2, arms: "back", legs: "wide" },
  jumpB: { dy: -3, arms: "up" },
  jumpC: { dy: -5, arms: "up", legs: "tuck" },
  jumpD: { dy: 1, arms: "out", legs: "wide" },
  // carrying a stack of documents, walking
  carryA: { step: 1, arms: "carry", beat: 0 },
  carryB: { step: 2, arms: "carry", beat: 1 },
};

/** One frame is 16 x 32. */
export const FRAME = { w: 16, h: 32 };
/** The rows of every sheet, top to bottom. Facing left is the "side" row mirrored. */
export const VIEWS = ["down", "up", "side"];
/** The base sheet's frames, left to right: 0-2 walk (1 = standing), 3-4 typing, 5-6 reading. 112 x 96 in all. */
export const BASE_POSES = ["walkA", "stand", "walkB", "typeA", "typeB", "readA", "readB"];
/** Extra action sheets, each (frames x 16) x 96 with the same three rows. */
export const ACTIONS = {
  umbrella: ["umbrellaA", "umbrellaB"],
  jump: ["jumpA", "jumpB", "jumpC", "jumpD"],
  carry: ["carryA", "carryB"],
};
