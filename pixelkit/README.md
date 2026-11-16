# pixelkit

AgentDesk의 캐릭터, 배경, 메뉴 UI를 그림 파일 없이 코드로 그리는 도구 묶음입니다. 코드로 그리고, 견본 PNG로 뽑아서 눈으로 보고, 자동 검사로 거르는 세 단계를 한 폴더에서 처리합니다. Node 기본 기능만 사용하므로 패키지를 설치할 필요가 없습니다.

```sh
node pixelkit/tools/render.mjs     # 견본 4장: pixelkit/records/char.png, tile.png, ui.png, dock-street.png
node pixelkit/tools/check.mjs      # 목록에 있는 그림 전부를 규격대로 검사
node --test test/pixelkit.test.mjs # 단위 테스트
```

앱이 읽는 그림(`assets/pixel/town/`의 캐릭터 시트와 도크 거리 배경)은 `node pixelkit/tools/export-app.mjs`로 내보냅니다. 자세한 내용은 아래 "앱으로 내보내기"에 있습니다.

## 구성

| 폴더 | 내용 |
|---|---|
| `core/` | 캔버스(`Canvas`), 색 단계표와 팔레트, 씨앗 난수, PNG 저장과 읽기, 3x5 글꼴 |
| `char/` | 16x32 캐릭터를 부품 조합으로 그리는 틀, 기본 시트와 추가 동작 시트 |
| `tile/` | 바닥, 벽, 하늘, 건물 조각과 경계 검사 |
| `ui/` | 9-slice, 패널, 버튼 3상태, 16x16 아이콘 |
| `catalog.js` | 그리는 것 전체의 목록. 두 도구가 이 목록을 함께 사용합니다. |
| `app.js` | 앱으로 내보내는 그림의 목록(`appFiles()`) |
| `tools/` | `render.mjs`(견본), `check.mjs`(검사), `export-app.mjs`(앱으로 내보내기), `lib/`(견본 배치, 검사 함수) |
| `records/` | 견본 PNG가 저장되는 곳 |
| `SKILL.md` | 새 그림을 만드는 절차와 증상별 처방표 |
| `NOTICE.md` | 다른 MIT 코드에서 옮겨 온 부분의 출처와 저작권 표기 |

## core: 캔버스와 색

색은 32비트 정수이고, 0은 "아무것도 없음"을 뜻합니다. 점은 기본적으로 불투명하며, 색을 섞지 않습니다. 옅어지는 표현은 4x4 격자 디더로 처리합니다.

```js
import { Canvas, hex, shade, tint, RAMP, INK, savePNG, loadPNG, Rng } from "./pixelkit/core/index.js";

const g = new Canvas(32, 32);
g.rect(4, 8, 24, 16, hex("#f0d6a8"));           // 사각형
g.hline(8, 4, 27, tint(hex("#f0d6a8")));        // 윗면에 밝은 줄
g.circle(15.5, 15.5, 5, RAMP.mint[1]);          // 원(.5로 끝나면 중심이 두 점 사이)
g.rect(4, 22, 24, 2, shade(hex("#f0d6a8")), 0.5); // a = 0.5: 디더로 반만 찍기
g.line(6, 10, 12, 20, INK);                     // 선
g.outline(INK);                                 // 그린 것 둘레에 1px 외곽선
const mirrored = g.flipX();                     // 좌우 반전
savePNG("out/thing.png", g);
```

- 도형: `set` `dot` `hline` `vline` `line` `rect` `frame` `roundRect` `circle` `ellipse` `ring` `bands`(디더로 이어지는 색 띠)
- 가공: `outline` `sprite`(문자열 그림) `text` `blit` `paste` `flipX` `crop` `scaled` `replace`
- 색: `hex` `mix` `shade`(차가운 어둠 쪽으로) `tint`(따뜻한 밝음 쪽으로) `steps` `fit` `at`, 팔레트 `PAL` / `RAMP`(이름마다 어두운 색에서 밝은 색까지 4단계)
- 난수: `new Rng(seed)`, `rand(...정수)`, `tileNoise`. 씨앗에는 숫자와 문자열을 모두 쓸 수 있습니다.
- PNG: `savePNG` `loadPNG` `toPNG` `fromPNG`. 읽기는 8비트 회색, 회색+알파, RGB, RGBA와 1~8비트 팔레트를 지원하며, 16비트와 인터레이스는 지원하지 않습니다.

## char: 캐릭터

```js
import { baseSheet, actionSheet, frame, character, randomCharacter, PRESETS } from "./pixelkit/char/index.js";

const spec = {
  skin: "tan",
  hair: { style: "bob", color: "black" },
  hat: null,                                   // { kind: "cap" | "beanie", color }
  top: { kind: "hoodie", color: "#ef8a5b", sleeve: "long" },
  bottom: { kind: "pants", color: "#4a4458" },
  props: ["glasses"],                          // glasses, headphones, scarf, badge
  accent: "#f2c14e",                           // 우산, 서류철, 목도리 색
};
baseSheet(spec);                // 112x96: 기존 시트와 같은 규격
actionSheet(spec, "umbrella");  // 32x96: 우산 쓰고 걷기 2프레임
actionSheet(spec, "jump");      // 64x96: 웅크림, 도약, 정점, 착지 4프레임
actionSheet(spec, "carry");     // 32x96: 서류 들고 걷기 2프레임
frame(spec, "side", "jumpC");   // 16x32 한 칸
randomCharacter("desk-3");      // 씨앗으로 조합. 같은 씨앗이면 같은 사람
```

- 시트의 줄은 위에서부터 아래 보기, 위 보기, 오른쪽 보기 순서입니다. 왼쪽 보기는 오른쪽 줄을 좌우 반전해서 사용합니다.
- 기본 시트의 칸은 0–2 걷기(1이 서 있기), 3–4 타이핑, 5–6 읽기입니다. `assets/pixel/town/char_*.png`와 크기, 칸 배치, 발 위치가 같습니다.
- 부품 표는 `char/parts.js`에 있습니다. 표에 없는 이름을 쓰면 오류가 발생합니다.
- 자세는 `char/poses.js`의 자료입니다. 새 동작은 `POSES`에 자세를, `ACTIONS`에 프레임 순서를 추가해서 만듭니다. 팔 모양이 새로 필요하면 `char/draw.js`의 `front`와 `side`에 가지를 추가합니다.

## tile: 배경 조각

```js
import { floor, wall, wallWindow, sky, cloud, skyline, facade, windowPiece, roofPiece, awningPiece, doorPiece, building, seamReport, joinReport, tiled } from "./pixelkit/tile/index.js";

floor("plank");                      // 16x16: plank, slab, checker, carpet, terrazzo, pavement, grass
wall("panel", { color: "#cfe6dc" }); // 16x32: plain, panel, brick. 가로로 이어 붙입니다.
wallWindow({ sky: "dusk" });         // 32x32: plain 벽과 이어집니다.
sky("night", { seed: 2 });           // 32x64: sky, dusk, night. 가로로 이어 붙입니다.
building({ cols: 4, floors: 2, color: "cream", roof: "coral", seed: 1 });

seamReport(floor("plank"));          // { ok, x: { seam, inner, contrast, innerContrast, ok }, y: {...} }
joinReport(wall("plain"), wallWindow(), "right");
tiled(floor("plank"), 4, 3);         // 눈으로 볼 때 쓰는 반복 그림
```

경계 검사는 타일 가장자리를 건너갈 때 바뀌는 점의 수와 세기를 타일 안쪽에서 가장 많이 바뀌는 자리와 비교합니다. 가장자리가 안쪽보다 더 많이 바뀌면 이음매가 보인다고 판정합니다. 가장자리에서 끊긴 무늬 하나처럼 안쪽에도 같은 종류의 끊김이 있는 경우는 잡아내지 못하므로, `tiled()`로 뽑아서 눈으로도 확인해야 합니다.

### 도크 거리

도크 막대(높이 72px) 뒤에 까는 거리 그림입니다. 그림 1px이 화면 1px이고 캐릭터와 같은 배율입니다.

```js
import { streetSky, street, streetLamp, streetCloud, LIT_REGIONS, STREET } from "./pixelkit/tile/index.js";

streetSky("dusk");            // 64x72: day, dusk, night. 가로로 이어 붙입니다.
street();                     // 512x72: 가게와 집의 1층 정면, 보도, 차도 경계. 가로로 이어 붙입니다.
street({ lit: true });        // 같은 그림에서 창문, 가게, 문 옆 등만 켠 것
streetLamp({ lit: true });    // 16x36 가로등. 켜면 유리가 밝아지고 반투명 빛무리가 생깁니다.
streetCloud();                // 36x15 구름
```

- 세로 구성: y 0–39는 건물(위와 사이는 투명), y 40–67은 보도, y 68–71은 연석과 차도 경계입니다. 캐릭터의 발은 y 46(`STREET.feet`)에 놓습니다.
- 문은 높이 28px(y 12–39)로 캐릭터 키와 같습니다.
- 낮 그림과 밤 그림은 한 번의 그리기 과정에서 `lit` 값만 바꿔 만들기 때문에, `LIT_REGIONS`에 적힌 사각형 밖에서는 완전히 같습니다. 불빛은 y 44 위에만 있어서 캐릭터와 이름표 자리를 건드리지 않습니다.
- 건물 배치는 `tile/street.js`의 `ROW` 표입니다. 폭의 합이 512여야 하고, 양 끝은 빈 틈이어야 이어 붙였을 때 벽이 잘리지 않습니다.

## ui: 메뉴

```js
import { panel, button, icon, nineSlice, ICON_NAMES } from "./pixelkit/ui/index.js";

panel("window", 96, 56, { title: "SETTINGS" });   // paper, dark, window, note
button("normal", 48, 16, { color: "mint", label: "OK" });   // normal, raised, pressed
button("raised", 22, 22, { color: "cream", icon: icon("gear") });
icon("bell");   // gear book sword bell plus close refresh play check folder search heart
nineSlice(source, { l: 6, r: 6, t: 12, b: 6 }, 120, 80);    // 직접 그린 원본에도 쓸 수 있습니다.
```

버튼은 세 상태가 같은 바깥 크기를 유지합니다. `raised`는 면이 1px 올라가고 `pressed`는 2px 내려가며, 글자와 아이콘도 면을 따라 움직입니다. 글자는 영문 대문자, 숫자, 기호 몇 개만 있는 3x5 글꼴입니다.

## 도구

```sh
node pixelkit/tools/render.mjs                       # 묶음별 견본 4장(char, tile, ui, dock-street)
node pixelkit/tools/render.mjs char                  # 한 묶음
node pixelkit/tools/render.mjs floor icon/gear       # 고른 것만 한 장(records/pick.png)
node pixelkit/tools/render.mjs "icon/*" --name icons --zoom 8 --width 1200
node pixelkit/tools/render.mjs --list                # 목록
node pixelkit/tools/check.mjs                        # 전부 검사. 실패가 있으면 종료 코드 1
node pixelkit/tools/check.mjs char floor
```

`check.mjs`가 보는 것은 다음과 같습니다.

| 검사 | 내용 | 결과 |
|---|---|---|
| 크기 | `size`와 정확히 같은지, `frame`의 정수배인지 | 실패 |
| 색 수 | `maxColors` 이하인지 | 실패 |
| 반투명 | 알파가 0도 255도 아닌 점이 있는지(`soft`로 허용) | 실패 |
| 떠 있는 점 | 주위 8칸이 모두 비어 있는 점 | 실패 |
| 외톨이 점 | 주위 8칸에 같은 색이 없는 점이 `maxLone`보다 많은지. 타일은 반대편 가장자리까지 이웃으로 계산합니다. | 주의 |
| 가장자리 | `clip`: 프레임 테두리에 외곽선 색이 아닌 점이 있는지(그림이 잘림). `opaque`: 빈 점이 있는지 | 실패 |
| 타일 경계 | `tile: { x, y }` 방향으로 반복했을 때와 `joins`에 적은 이웃 조각과의 경계 | 실패 |
| 반복성 | 두 번 그려서 결과가 같은지 | 실패 |
| 난수 | `pixelkit/` 소스에 씨앗 없는 난수 호출이 있는지 | 실패 |

## 앱으로 내보내기

```sh
node pixelkit/tools/export-app.mjs            # assets/pixel/town/ 에 56개 파일을 다시 만듭니다.
node pixelkit/tools/export-app.mjs --check    # 쓰지 않고, 디스크의 파일이 코드와 다르면 종료 코드 1
node pixelkit/tools/export-app.mjs --out dir  # 다른 폴더에 쓰기
node pixelkit/tools/render.mjs dock-street    # 견본: pixelkit/records/dock-street.png
```

| 파일 | 크기 | 내용 |
|---|---|---|
| `char_0.png` … `char_11.png` | 112x96 | 기본 시트. 16x32 프레임 7개 x 3줄 |
| `char_N_umbrella.png` | 32x96 | 우산 쓰고 걷기 2프레임 |
| `char_N_jump.png` | 64x96 | 뛰어오르기 4프레임 |
| `char_N_carry.png` | 32x96 | 서류 들고 걷기 2프레임 |
| `street_sky_day.png`, `street_sky_dusk.png`, `street_sky_night.png` | 64x72 | 하늘 |
| `street_front.png`, `street_front_lit.png` | 512x72 | 거리 정면의 낮 그림과 불 켠 그림 |
| `street_lamp.png`, `street_lamp_lit.png` | 16x36 | 가로등. 발이 맨 아래 줄에 있습니다. |
| `street_cloud.png` | 36x15 | 구름 |

- 캐릭터 번호는 `char/parts.js`의 `PRESETS` 순서입니다(0 sky, 1 coral, 2 rose, 3 mint, 4 sun, 5 cloud, 6 berry, 7 peach, 8 moss, 9 amber, 10 pine, 11 lilac).
- 도크는 아래 보기 줄을 위 4px이 잘린 16x28 창으로 보여 줍니다. 우산은 그 창 안에 들어오도록 머리 바로 위에 낮게 그립니다.
- `scripts/office-town.mjs`도 `char_0.png` … `char_11.png`를 같은 폴더에 씁니다(이전 그림). 그 스크립트를 실행한 뒤에는 이 도구를 다시 실행해야 합니다. 테스트가 디스크의 파일과 코드의 결과가 같은지 확인하므로, 어긋나면 테스트가 실패합니다.
- 켜진 가로등의 빛무리만 반투명 점을 씁니다. 나머지 그림은 모두 불투명합니다.

## 새 그림을 목록에 추가하기

`catalog.js`에 항목을 하나 추가하면 견본과 검사에 함께 포함됩니다.

```js
add({ id: "floor/mosaic", group: "tile", zoom: 3,
      draw: () => T.floor("mosaic"),                 // 실제 그림
      show: () => T.tiled(T.floor("mosaic"), 4, 3),  // 견본에서 보여 줄 모습(생략 가능)
      spec: { size: [16, 16], opaque: true, maxColors: 8, maxLone: 4, tile: { x: true, y: true } } });
```

만드는 절차와 품질 기준은 `SKILL.md`를 따릅니다.
