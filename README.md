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

- **Session Dashboard / 세션 대시보드** — Real-time monitoring of all Orca worktree sessions with status detection (running / waiting / done / error). Orca 워크트리 세션의 실시간 상태(실행 중 / 대기 / 완료 / 오류)를 모니터링합니다.
- **Pixel Office / 픽셀 오피스** — Every recent session becomes a pixel-art agent. Working agents sit at station desks (dev / research / exec / docs) and type or read with a live tool tag; idle agents rest on the lounge sofa; agents in a collaboration debate gather around a meeting table. Click a character to chat, double-click to jump to its Orca terminal. 최근 세션이 픽셀 캐릭터로 표시됩니다. 작업 중이면 스테이션 책상에서 타이핑·읽기, 쉬면 휴게실 소파, 협력 토론 중이면 회의 테이블에 모입니다. 클릭하면 채팅, 더블클릭하면 Orca 터미널로 전환됩니다.
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

빌드가 완료되면 `dist/Orca Dashboard-0.1.0-arm64.dmg` 파일이 생성됩니다.

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
| 트레이 아이콘 | 클릭으로 위젯 표시/숨김, 우클릭으로 메뉴 |

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
| 💬 (typing) | 실행 중 | 최근 2분 이내 출력 또는 도구 실행 중 |
| 💤 | 대기 중 | 사용자 입력 대기 |
| ✅ | 완료 | 작업 완료 |
| ⚠️ | 오류 | 에러 발생 |

---

## How It Works / 동작 원리

위젯은 Orca CLI(`orca worktree ps`, `orca terminal list` 등)와 통신하여 세션 데이터를 가져옵니다. 또한 `~/.claude/projects/` 디렉터리의 Claude Code `.jsonl` 세션 파일을 읽어 상세한 세션 기록을 표시합니다.

### Status Detection / 상태 판별

| 조건 | 판별 결과 |
|---|---|
| `state=working` + 최근 출력 (2분 이내) | Running |
| `state=working` + 활성 도구 (`toolName` 존재) | Running |
| `state=working` + 최근 출력 없음 + 도구 없음 | Done |
| `state=waiting` / `pending` | Waiting |
| `state=error` | Error |
| 모든 타임스탬프 10분 이상 경과 | Done |

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
