Pixel assets in this folder come from Pixel Agents (MIT, Pablo De Lucca)
https://github.com/pixel-agents-hq/pixel-agents

pet_gitcat.png ("Gitcat") and pet_claudio.png ("Claudio") are pets from Pixel Agents (MIT), pet sprites by itsManeka
https://github.com/pixel-agents-hq/pixel-agents/tree/main/webview-ui/public/assets/pets

k_*.png are single tiles cut from Kenney's "Roguelike Indoors" and "Roguelike Modern City" packs (CC0 / public domain)
https://kenney.nl/assets/roguelike-indoors · https://kenney.nl/assets/roguelike-modern-city

Characters are based on "Metro City Free Topdown Character Pack" by JIK-A-4 (CC0)
https://jik-a-4.itch.io/metrocity-free-topdown-character-pack

Pixel font: Galmuri9 by quiple (SIL Open Font License 1.1) — see ../fonts/LICENSE-Galmuri.txt
https://github.com/quiple/galmuri

UI fonts (../fonts): Manrope by Mikhail Sharanda and JetBrains Mono by JetBrains — both SIL Open Font License 1.1
https://github.com/sharanda/manrope · https://github.com/JetBrains/JetBrainsMono

fx/*.png are sprite sheets baked from pixelfx by Patch (MIT; parts adapted from Hugo Duprez's Sprite Fusion effects, MIT)
by scripts/office-fx.mjs: collect-burst, blink-in / blink-out (with our char_0 as the silhouette), exclamation; zzz, skill-cast (the skill book; skill-cast-dock is its dock-tile cut), steam, rack-a/b, sky-*, act-* (the dock tiles' activity loops), play-* (the dock's test monster, clash, fatigue) and job-hats are
our own effects (scripts/office-fx/*.js) rendered with its tools
https://github.com/patch-gg/pixelfx · https://www.spritefusion.com/pixel-art-vfx

char_6.png … char_11.png are recolors of char_0 … char_5 (same Metro City frames, new hair and clothes), made by
scripts/office-skins.mjs

## UI pixel icons

The 12 x 12 icons that replace colour emoji in the widget (gear, book, sword, shop, key, …) are our own drawings, kept as
text grids in scripts/pixel-icons.mjs and generated into widget.html as inline SVG (`node scripts/pixel-icons.mjs`).
