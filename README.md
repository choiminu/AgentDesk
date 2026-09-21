# Orca Widget

A lightweight Electron desktop widget for monitoring [Orca](https://github.com/stablyai/orca) AI coding sessions at a glance.

[Orca](https://github.com/stablyai/orca) AI 코딩 세션을 실시간으로 모니터링하는 경량 Electron 데스크톱 위젯입니다. 세션 상태 확인, 오케스트레이션 관리, 클립보드 히스토리, 포트 모니터, 메모, 뽀모도로 타이머 등의 기능을 제공합니다.
<img width="1772" height="869" alt="image" src="https://github.com/user-attachments/assets/5e9c3146-bf3b-4b1f-b525-7f08f5502929" />


<!-- Add your own screenshot: place screenshot.png in the repo root -->
<!-- ![Screenshot](screenshot.png) -->

![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)
![Electron](https://img.shields.io/badge/electron-36-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features / 기능

- **Session Dashboard / 세션 대시보드** — Real-time monitoring of all Orca worktree sessions. Status is read from the live terminal screen every 2 seconds (spinner → running, `✻ … done` → waiting, permission/question prompt → needs input), so it stays correct even when Orca's own agent state lags. Orca 워크트리 세션을 실시간으로 모니터링합니다. 상태는 2초마다 터미널 화면을 읽어 판정하므로(스피너 → 작업 중, `✻ … done` → 대기, 선택지 → 선택 필요) Orca 상태가 지연되어도 정확합니다.
- **Pixel Office / 픽셀 오피스** — Every recent session becomes a pixel-art agent. Working agents sit at station desks (dev / research / exec / docs, chosen from the tools they use) and type or read with a live tool tag and a context-window gauge; subagents spawned by a session appear as `↳ name` characters at the next desk; idle agents rest on the lounge sofa; agents in a collaboration debate gather around a meeting table. A wall whiteboard summarizes the room. Click a character to chat, double-click to jump to its Orca terminal, right-click for actions. 최근 세션이 픽셀 캐릭터로 표시됩니다. 작업 중이면 도구에 따라 배정된 스테이션 책상에서 타이핑·읽기(도구 태그·컨텍스트 게이지 표시), 서브에이전트는 옆 책상에 `↳ 이름` 캐릭터로 등장, 쉬면 휴게실 소파, 협력 토론 중이면 회의 테이블에 모입니다. 클릭하면 채팅, 더블클릭하면 Orca 터미널, 우클릭하면 액션 메뉴입니다.
- **Exact Detection via Hooks / 훅 기반 정확 감지 (opt-in)** — One click registers Claude Code hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, `PermissionRequest`, `SubagentStart/Stop`, `SessionEnd`) that append events to `~/.roca/events.jsonl`; the widget tails it and gets working / waiting / needs-input, the current tool, and subagents as facts with zero delay. Existing hooks are preserved and the previous settings are backed up. 버튼 한 번으로 Claude Code 훅을 등록해 작업 중·대기·선택 필요·현재 도구·서브에이전트를 이벤트로 즉시 받습니다. 기존 훅은 보존되고 이전 설정은 `~/.roca/`에 백업됩니다.
- **Needs-input Alerts / 선택 필요 알림** — System notification, in-app toast, tray badge and an optional chime fire only when an agent is actually waiting for a choice (permission prompt or `AskUserQuestion`), not on every finished turn. 에이전트가 권한 승인·질문 선택을 기다릴 때만 알림(시스템 알림·토스트·트레이·선택형 알림음)이 뜹니다.
- **Collaboration / 협력 토론** — Relay a debate between two groups of sessions (A ↔ B) or run master-worker mode where workers discuss and the master summarizes. 두 그룹 간 릴레이 토론과 마스터-워커 모드를 지원합니다.
- **Orchestration / 오케스트레이션** — Manage orchestration runs, tasks, workers, and phase assignments. 오케스트레이션 실행, 태스크, 워커, 페이즈를 관리합니다.
- **Clipboard History / 클립보드 히스토리** — Tracks clipboard changes with one-click copy and search. 클립보드 변경 기록을 추적하며 원클릭 복사 및 검색을 지원합니다.
- **Port Monitor / 포트 모니터** — Lists all listening TCP ports with process info and kill option. 리슨 중인 TCP 포트 목록과 프로세스 정보를 표시하며 프로세스 종료가 가능합니다.
- **Quick Memo / 메모** — Persistent scratchpad with auto-save. 자동 저장되는 메모장입니다.
- **Pomodoro Timer / 뽀모도로 타이머** — Focus timer with system notifications. 시스템 알림이 포함된 집중 타이머입니다.
- **File Drag & Drop / 파일 드래그앤드롭** — Drag files onto a session card to insert the file path into its terminal prompt. 파일을 세션 카드에 드래그하면 터미널 프롬프트에 경로가 입력됩니다.
- **Minimize Mode / 최소화 모드** — Collapse to a compact header bar showing only session counts. 헤더 바만 남기는 미니 모드를 지원합니다.
- **Window Memory / 창 위치 기억** — Remembers last window position and size across restarts. 마지막 창 위치와 크기를 기억합니다.

---

## Installation / 설치

### 1. Prerequisites / 사전 요구사항

#### Orca

[Orca](https://github.com/stablyai/orca)가 설치되어 있어야 합니다.

```bash
brew install --cask stablyai/orca/orca
```

설치 후 Orca 앱을 한 번 실행하여 초기 설정을 완료하세요.

```bash
orca open
```

정상 설치 확인:

```bash
orca --version
# 1.4.x 이상이 출력되면 정상
```

#### Node.js

Node.js 18 이상이 필요합니다.

```bash
node --version
# v18.x.x 이상
```

설치되어 있지 않다면:

```bash
brew install node
```

### 2. Clone / 저장소 복제

```bash
git clone https://github.com/choiminu/orca-widget.git
cd orca-widget
```

### 3. Install Dependencies / 의존성 설치

```bash
npm install
```

### 4. Run / 실행

```bash
npm start
```

개발 모드로 실행하려면:

```bash
npm run dev
```

위젯이 화면 우하단에 항상 최상위(always-on-top)로 표시됩니다.

---

## Build DMG / DMG 빌드

macOS용 설치 파일(DMG)을 빌드하려면:

```bash
npm run dist
```

빌드가 완료되면 `dist/` 아래에 Apple Silicon용 `Orca Dashboard-0.1.0-arm64.dmg`와 Intel용 `Orca Dashboard-0.1.0.dmg`(x64)가 생성됩니다. 자기 Mac에 맞는 파일을 설치하세요.

> **Orca 버전**: 1.4 이상이 필요합니다(`terminal read --screen`, `--json`). 구버전이면 대시보드에 경고 배너가 표시됩니다.
>
> **세션 목록이 비어 있다면**: 위젯은 `orca` CLI를 `/usr/local/bin`, `/opt/homebrew/bin`, `/Applications/Orca.app/Contents/Resources/bin` 순으로 찾습니다. 호출에 실패하면 대시보드 상단에 빨간 배너로 원인이 표시됩니다. 터미널에서 `orca --version`이 되는지, Orca 앱이 실행 중인지 확인하세요. 필요하면 `sudo ln -s /Applications/Orca.app/Contents/Resources/bin/orca /usr/local/bin/orca`로 링크를 만들 수 있습니다.

> **참고**: 코드 서명이 되어 있지 않으므로, DMG를 설치한 후 첫 실행 시 macOS에서 "확인되지 않은 개발자" 경고가 표시될 수 있습니다. **시스템 설정 > 개인정보 보호 및 보안**에서 "확인 없이 열기"를 클릭하세요.

---

## Usage / 사용법

### 기본 조작

| 동작 | 설명 |
|---|---|
| 헤더 드래그 | 위젯 위치 이동 |
| ▾ 버튼 | 최소화 (헤더만 표시) |
| ▴ 버튼 | 복원 |
| 탭 전환 | 대시보드 / 오피스 / 오케스트레이션 / 협력 / 클립보드 / 포트 / 메모 / 타이머 |
| 파일 드래그앤드롭 | 세션 카드에 파일을 드롭하면 경로가 터미널에 입력됨 (전송하지 않음) |
| 우클릭 (카드 / 오피스 캐릭터) | 채팅 열기 · Orca 터미널 보기 · 세션 ID 복사 · 인터럽트 · 세션 종료 |
| Esc | 채팅 패널 / 메뉴 닫기 |
| 트레이 아이콘 | 클릭으로 위젯 표시/숨김, 우클릭으로 메뉴. 제목에 `▶실행 수 ?선택 필요 수` 표시 |

### 오피스 탭

| 요소 | 의미 |
|---|---|
| 스테이션 (개발 / 조사 / 실행·테스트 / 문서화) | 최근 도구의 다수결로 배정. Edit/Write → 개발(`.md`, `docs/`, README 등은 문서화), Read/Grep/Glob/Web → 조사, Bash → 실행·테스트 |
| 파란 카펫 + 도구 태그 + 켜진 모니터 | 작업 중. 태그 아래 점은 직전 도구 3개 |
| 노란 카펫 + ❓ + 손 흔들기 | 선택 필요(권한·질문). 일반 대기는 조용히 ✓ 표시 |
| 빨간 카펫 + ! | 오류 |
| `↳ 이름` 캐릭터 (옅은 파랑) | 부모 세션이 띄운 서브에이전트. 끝나면 사라짐 |
| 휴게실 소파 | 쉬는(완료) 세션. 최근 24시간 목록에서 빠지면 캐릭터도 사라짐 |
| 회의실 | 협력 토론 진행 중인 A·B 그룹과 마스터가 모여 앉음. 발언자에게 말풍선 |
| 이름표 아래 게이지 | 컨텍스트 사용량. 75% 노랑, 90% 이상 빨강 깜빡임 |
| 화이트보드 | 작업/대기/오류/휴식 인원과 가장 오래 기다린 세션 |
| 상단 바 | 배율(자동/2×/3×/4×), **정확 감지** 토글(훅 등록/해제), 알림음 토글 |

### 세션 카드 액션

| 버튼 | 설명 |
|---|---|
| 📌 | 세션 고정/해제 |
| 📋 | 세션 ID 복사 |
| ⏸ | 세션 인터럽트 |
| ✕ | 세션 종료 |

### 세션 상태 아이콘

| 아이콘 | 상태 | 조건 |
|---|---|---|
| 💬 (typing) | 실행 중 | 터미널에 스피너(`· Working… (12s · ↓ 1.2k tokens)`) 또는 응답 스트리밍 중 |
| ❓ | 선택 필요 | 권한 승인 / `AskUserQuestion` 선택지가 떠 있음 |
| 💤 | 대기 중 | 턴이 끝난 뒤 10분 이내 (`✻ … done 2:34 PM`) |
| ✅ | 완료 | 끝난 뒤 10분 경과, 또는 다른 날에 끝남 |
| ⚠️ | 오류 | 에러 발생 |

카드의 시간은 상태 기준입니다: `작업 3m`(작업 시작 후), `대기 12s`(응답 완료 후), 완료 세션은 마지막 활동 시각. `🤖2`는 실행 중인 서브에이전트 수, `ctx 46%`는 컨텍스트 사용량입니다.

---

## How It Works / 동작 원리

위젯은 Orca CLI(`orca worktree ps`, `orca terminal list`)로 세션 목록을 5초마다 가져오고, 열려 있는 터미널은 `orca terminal read --screen`으로 2초마다 화면을 읽어 실제 상태를 판정합니다. `~/.claude/projects/`의 Claude Code `.jsonl` 세션 파일은 세션 기록 보기에 사용합니다.

### Exact Detection (hooks) / 훅 기반 정확 감지

> **다른 Mac에 설치했다면 정확 감지를 켜는 것을 권장합니다.** 화면 판독은 Claude Code TUI 문구와 시스템 로케일(영문/한국어 시각 표기는 지원)에 의존하지만, 훅은 이벤트를 그대로 받으므로 환경과 무관하게 정확합니다. 단, Claude Code 세션에만 적용되며 다른 에이전트(opencode, gemini 등)는 화면 판독·Orca 상태로 동작합니다.

오피스 탭의 **정확 감지** 버튼을 켜면 `~/.claude/settings.json`에 위젯 훅이 등록됩니다(기존 항목 보존, `~/.roca/settings.backup-*.json`에 백업). 훅 스크립트 `~/.roca/hook.sh`는 이벤트 JSON을 `~/.roca/events.jsonl`에 한 줄씩 덧붙이기만 하고 즉시 종료하며(비동기, 5초 제한), 위젯이 이 파일을 감시합니다. Claude Code는 훅 설정을 즉시 다시 읽으므로 이미 실행 중인 세션에도 바로 적용됩니다.

| 이벤트 | 위젯 상태 |
|---|---|
| `UserPromptSubmit`, `PreToolUse`(도구명·대상 기록), `PostToolUse` | Running |
| `Stop` | Waiting (10분 후 Done) |
| `PermissionRequest`, `Notification`(`permission_prompt`, `agent_needs_input`, `elicitation_*`), `PreToolUse(AskUserQuestion)` | Waiting + **Needs input** |
| `SubagentStart` / `SubagentStop`, 서브에이전트 안의 `PreToolUse` | 서브에이전트 등장·도구 표시·퇴장 |
| `SessionEnd` | Done |

훅 이벤트는 워크트리 경로와 이벤트의 `cwd`로 세션에 매칭되며, 훅 데이터가 있는 세션은 아래 화면 판독보다 우선합니다. 훅이 없는 세션(다른 에이전트, 훅 미설치)은 화면 판독으로 동작합니다. 끄면 위젯 훅만 제거됩니다.

### Status Detection (screen) / 화면 판별

터미널 화면의 마지막 `❯` 프롬프트 줄을 기준으로, 그 위의 첫 의미 있는 줄을 봅니다(들여쓰기된 안내줄과 상태 표시줄은 건너뜀). 화면 판정이 있으면 Orca의 `agents[0].state`보다 우선합니다.

| 화면 | 판별 결과 |
|---|---|
| 스피너 줄 `· Scurrying… (1m 14s · ↓ 3.8k tokens)` / `esc to interrupt` | Running |
| 스피너 없이 `⏺` 응답만 남음 (턴 종료, done 줄 없음) | Waiting → 화면이 10분간 그대로면 Done |
| `✻ Worked for 22s · done 2:34 PM` (10분 이내) | Waiting |
| `✻ … done` 10분 경과, 또는 `done Thursday 10:28 AM`처럼 다른 날 | Done |
| `❯ 1. Yes` 선택지 / `Do you want …` | Waiting + Needs input |
| 프롬프트가 없는 셸 터미널 | Orca 상태 사용 |

같은 화면에서 추가로 읽는 정보: 상태 표시줄 아래 에이전트 패널(`⏺ main` / `◯ name  설명  17s · ↓ 30.5k tokens` 또는 `idle`) → 서브에이전트 목록, OMC 상태 표시줄의 `ctx:[#####-----]46%` → 컨텍스트 사용량.

### Developer Switches / 개발용 환경 변수

| 변수 | 동작 |
|---|---|
| `ROCA_START_PAGE=office` | 지정 탭으로 시작. `office-demo`는 가짜 세션 8개(서브에이전트·선택 필요·회의 포함)로 오피스를 재현 |
| `ROCA_SHOT=/path/shot.png` | 6·14·22초 시점에 창을 `shot-1.png`… 로 저장 |
| `ROCA_DEBUG=1` | 터미널 읽기 로그 출력 |
| `ROCA_HOOKS_INSTALL=1` | 시작 시 훅을 바로 등록 |
| `ROCA_ORCA_BIN=/path/orca` | Orca CLI 경로 강제 지정 (오류 배너 테스트 등) |

---

## Project Structure / 프로젝트 구조

```
main.mjs       — Electron main process, IPC handlers, Orca CLI bridge
                 (Electron 메인 프로세스, IPC 핸들러, Orca CLI 브릿지)
assets/pixel   — Pixel office sprites (characters, furniture) + CREDITS.md
                 (픽셀 오피스 스프라이트와 출처)
assets/fonts   — Galmuri9 pixel font (OFL)
widget.html    — Single-file frontend (HTML + CSS + JS)
                 (단일 파일 프론트엔드)
preload.cjs    — Context bridge exposing IPC to renderer
                 (렌더러에 IPC를 노출하는 컨텍스트 브릿지)
package.json   — App config and electron-builder settings
                 (앱 설정 및 빌드 설정)
```

---

## Contributing / 기여

기여를 환영합니다! 자세한 내용은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

## Credits / 크레딧

- Pixel office furniture and character sheets come from [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) (MIT, Pablo De Lucca).
- Characters are based on the [Metro City Free Topdown Character Pack](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack) by JIK-A-4 (CC0).
- Pixel font [Galmuri](https://github.com/quiple/galmuri) by quiple (SIL Open Font License 1.1).

## License / 라이선스

[MIT](LICENSE)
