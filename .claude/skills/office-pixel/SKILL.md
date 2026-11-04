---
name: office-pixel
description: Add or change AgentDesk's pixel art — effects and ambient animations in the pixel office and on dock tiles (pixelfx sprite sheets), and extra character skins. Use when someone asks for a new office effect or prop animation ("steam on the coffee", "rain on the windows", "a sparkle when X happens"), wants an existing one changed (bigger, other color, slower), wants it on the dock too, or wants more characters. Works with the pixelfx skill/library; this skill is the AgentDesk side: specs, baking, wiring, checks.
---

# office-pixel

AgentDesk draws its office on a canvas (`widget.html`, `officeFrame`) and its dock as HTML tiles. Effects come from
[pixelfx](https://github.com/patch-gg/pixelfx) (MIT) but are **baked to sprite sheets** — no pixelfx code ships in the
widget, so the CSP and the bundle stay as they are. Characters are Metro City sheets (CC0) and recolors of them.

## Specs to design against

- World units: 1 px = 1 world px; tile 16 px; office scale ~2x on screen. A character is a **16 x 32** sheet cell
  (`assets/pixel/char_N.png`: 7 frames x 3 rows — down, up, side). `officeDrawChar(ctx, sheet, col, dir, x, y)` puts
  the sprite at `(x - 8, y - 24)`, so its **feet are at (x, y + 8)**: `officeFeet(ch)`.
- pixelfx draws at its stand-in's scale (24 x 38). Effects that read `o.actor` get **our** character instead (see
  `officeActor()` in `scripts/office-fx.mjs`); effects that only sit over a head need `dy: 6` (they are drawn 6 px lower).
- Frame rate: the office runs at ~32 fps only while something moves (`officeMoving`), 10 fps when still. One-shots
  (`officeFxPlay`) raise it while they play; ambient loops must look fine at **10 fps** and must not raise it.
- Dock tiles are 56 px (40 px small). Effects there are clipped to the tile (`.dock-fxc`); anything taller than
  the tile is cut, so shift loops down (see `feet` in `dockFxEl`) or skip them.
- Respect the switches: office effects always; dock effects only when `dockFxAllowed()` (dock animation setting and
  reduced motion). New CSS animations go under `@media (prefers-reduced-motion: no-preference)` and `.dock-tiles.fx`.

## A new or changed effect

1. **Look for an existing pixelfx effect first** (pixelfx skill: `node tools/list.mjs <words>`, render, look at the
   contact sheet). Recolor with a palette instead of writing one when it fits.
2. **A new one** goes in `scripts/office-fx/<name>.js` (copied into the pixelfx checkout as `src/fx/office/` when
   baking). Follow pixelfx `docs/AUTHORING.md`: `meta`, pure `draw(p, t, o)` for loops, deterministic, ends empty for
   one-shots. Keep it small (a window pane is 36 x 22, a cup's steam 12 x 18) and give loops `fps: 10`–`15`.
   Render and **look** at the contact sheet (`node tools/render.mjs office/<name> --zoom 6` in the checkout), fix the
   worst thing, repeat; `node tools/check.mjs office/<name>` must pass.
3. **Add it to `EFFECTS`** in `scripts/office-fx.mjs` (key, id, file, options; `actor: true` if it wraps the
   character, `head: true` if it floats over a stand-in's head), then bake:
   `node scripts/office-fx.mjs ../pixelfx` (or `$PIXELFX_DIR`). It writes `assets/pixel/fx/*.png` and prints the
   `OFFICE_FX` table: replace the `const OFFICE_FX = …` line in `widget.html` with it (one line, as printed).
4. **Wire it**:
   - one-shot on an event: `officeFxPlay(kind, ...officeFeet(ch), ch)` (pass `ch` to follow the character);
   - loop over something drawn: `officeFxDraw(ctx, kind, Math.floor(now / 1000 * OFFICE_FX[kind].fps + offset), x, y)`
     right after the thing is drawn (offset by `officeHash(id)` so copies are out of step);
   - dock: `dockFxPlay(key, kind)` from `dockFxSync` for one-shots (survives tile redraws), `dockFxEl(b, kind, true)`
     for loops.
5. Credit: a line in `assets/pixel/CREDITS.md` for pixelfx-derived sheets (MIT), and a pixelfx-style two-line credit
   at the top of a file that adapts a Sprite Fusion recipe.

## More characters

`scripts/office-skins.mjs` recolors the six source sheets into `char_6.png` … (hair and clothes colors are listed per
source sheet — don't guess them from hue, dark skin and black hair get mixed up). Add a `SKINS` row (and new ramps if
needed), run it, look at a montage of every frame row, then raise `OFFICE.CHAR_COUNT` and add `.dock-spr.kN` rules.
Raising the count reshuffles which hashed session gets which character; that is expected.

## Check before saying it's done

- `node --test test/office-fx.test.mjs` (table ↔ sheet sizes, wiring), then `npm test`; after editing the inline
  script `node scripts/csp-hash.mjs --write`; `node scripts/i18n-check.mjs` if you added UI text.
- See it in the real app: quit the running AgentDesk (single instance), start Electron with
  `ROCA_START_PAGE="office-demo"` (or `"dashboard,ko,skip-onboarding,demo"` then `dockEnter()` for the dock) and
  `--remote-debugging-port`, trigger the effect through `Runtime.evaluate` (`officeFxPlay(…)`, or change a demo
  session's status and `dockDraw()`), and capture with `Page.captureScreenshot`. `scripts/shots.mjs` shows the
  plumbing — but it overwrites `docs/screenshots/`, so don't commit those unless that's the point.
- Tiles: generated floor tiles were tried and lost to the existing tinted tiles (visible repetition); prefer CC0 packs
  for tiles and keep pixelfx for things that move.
