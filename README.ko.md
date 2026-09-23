# AgentDesk

AI 코딩 에이전트를 위한 픽셀 아트 사무실. AgentDesk는 Claude Code 세션을 실시간으로 지켜보고(일반 터미널이든 [Orca](https://github.com/stablyai/orca) 안이든), 각 에이전트가 무엇을 하는지 대시보드와 책상에 앉은 캐릭터로 보여 주는 macOS 데스크톱 위젯입니다.

*이전 이름은 "Orca Widget"입니다. Orca는 선택 사항이며 지원하는 에이전트 CLI 하나만 있으면 동작합니다.*

**지원 에이전트:** Claude Code, Gemini CLI, Codex CLI — 각 CLI의 자체 훅 체계를 사용하므로 상태가 정확합니다. [Orca](https://github.com/stablyai/orca) 안의 세션은 Orca CLI를 통한 터미널 제어도 됩니다.

[English README](README.md)

<img width="635" alt="대시보드" src="https://github.com/user-attachments/assets/6ec55127-14d7-495d-ad5d-9379c010775a" />

<img width="1772" alt="픽셀 오피스" src="https://github.com/user-attachments/assets/5e9c3146-bf3b-4b1f-b525-7f08f5502929" />

## 기능

- **실시간 대시보드** — 터미널·tmux·Orca에서 실행 중인 모든 Claude Code·Gemini CLI·Codex CLI 세션의 실제 상태(작업 중 / 입력 대기 / 선택 필요 / 완료 / 오류). 정확 감지를 켜면 Claude Code 훅 이벤트로, 아니면 터미널 화면을 읽어 판정하므로 Orca의 상태가 지연되어도 정확합니다.
- **픽셀 오피스** — 최근 세션이 캐릭터로 표시됩니다. 작업 중이면 사용하는 도구에 따라 배정된 스테이션(개발 / 조사 / 실행·테스트 / 문서화) 책상에서 도구 태그와 컨텍스트 게이지를 달고 일하고, 서브에이전트는 부모 옆에 나타나며, 쉬는 에이전트는 휴게실 소파에 앉습니다. 벽의 화이트보드가 현황을 요약합니다.
- **PM 팀** — 에이전트를 PM 자리에 드래그해 팀을 만들고 다른 에이전트를 팀원으로 끌어 넣습니다. PM에게 목표를 주면 팀 브리프를 쓰고 업무 분배를 제안하며, 승인하면 각 팀원이 브리프와 자기 태스크를 받습니다. 보고는 PM에게 자동으로 돌아갑니다.
- **선택 필요 알림** — 권한 승인이나 질문처럼 정말 사람이 답해야 할 때만 알림·토스트·트레이 배지·알림음이 뜹니다.
- **채팅 패널** — 캐릭터나 카드를 클릭하면 에이전트 화면을 읽고 메시지를 보낼 수 있고, 더블클릭하면 Orca 터미널로 전환됩니다.
- **유틸리티** — 클립보드 히스토리, 리스닝 포트 모니터(프로세스 종료), 메모, 뽀모도로 타이머.
- **Orca 유무와 무관하게 동작** — Orca가 있으면 Orca CLI로 세션 발견·채팅·터미널 제어를 하고, 없으면(Claude Code가 있는 어느 Mac이든) Claude Code 훅과 트랜스크립트로 세션을 발견합니다. tmux 안에서 실행 중인 세션은 채팅과 지시도 가능합니다. 두 종류의 세션이 한 목록에 함께 표시되며 따로 설정할 것은 없습니다.
- **영어·한국어 UI** — 기본은 영어, ⚙ 설정에서 전환.

## 빠른 시작

요구 사항: macOS·Linux·Windows, Node.js 18 이상, 에이전트 CLI 하나 이상(Claude Code, Gemini CLI 또는 Codex CLI). [Orca](https://github.com/stablyai/orca) 1.4 이상은 선택 사항이며, 없으면 훅 전용 모드(Claude Code 훅 + 메시지 전송용 [tmux](https://github.com/tmux/tmux))로 동작합니다.

```bash
git clone https://github.com/choiminu/AgentDesk.git
cd AgentDesk
npm install
npm start
```

설치 파일은 [GitHub 릴리스](https://github.com/choiminu/AgentDesk/releases)에 첨부됩니다(macOS DMG Apple Silicon·Intel, Linux AppImage·.deb, Windows 설치 프로그램·포터블 .exe). 직접 빌드하려면 `npm run dist`(macOS), `npm run dist:linux`, `npm run dist:win`을 사용합니다.

| 플랫폼 | 세션 상태(훅) | 채팅·지시·인터럽트 | 터미널 전환 | 종료 세션 다시 열기 |
|---|---|---|---|---|
| macOS | ✓ | Orca, tmux, iTerm2, Terminal.app | ✓ | iTerm2 / Terminal |
| Linux | ✓ | tmux만 | tmux 창 | gnome-terminal, konsole, kitty, alacritty, xterm… |
| Windows | ✓ | — | — | Windows Terminal / cmd | 코드 서명이 없으므로 첫 실행 시 **시스템 설정 → 개인정보 보호 및 보안**에서 열기를 허용해야 합니다.

처음 실행하면 짧은 온보딩이 이 Mac의 환경(Claude Code, 위젯 훅, Orca CLI, 터미널 자동화 권한)을 점검하고 **정확 감지**를 버튼 하나로 켤 수 있게 안내합니다. 정확 감지는 Claude Code 훅을 등록해([동작 원리](#동작-원리) 참고) 상태를 추정이 아닌 이벤트로 받게 하며, 이후에도 ⚙ 설정에서 켜고 끌 수 있습니다. 온보딩을 다시 보려면 `ROCA_START_PAGE=onboarding` 으로 실행합니다.

## 사용법

| 동작 | 결과 |
|---|---|
| 세션 카드 클릭 | 그 에이전트의 터미널(Orca·tmux·iTerm2·Terminal)을 앞으로 가져옵니다. 종료된 세션은 `claude --resume`으로 다시 엽니다 |
| 카드의 *채팅* 버튼 또는 캐릭터 클릭 | 해당 에이전트의 채팅 패널 열기 |
| 캐릭터 더블클릭 | 에이전트의 터미널로 전환 |
| 우클릭 | 메뉴: 채팅, 터미널, 세션 ID 복사, 인터럽트, 종료, 팀 액션 |
| 캐릭터를 PM 자리로 드래그 | 그 에이전트를 PM으로 팀 생성(드래그 중에 템플릿이 나타남) |
| 캐릭터를 팀 블록으로 드래그 | 팀원으로 합류, 밖에 놓으면 해제 |
| PM 우클릭 → *팀 목표 지시…* | 브리프 → 분배안 → 승인 → 전달 |
| 카드에 파일 드래그 | 해당 터미널 프롬프트에 파일 경로 입력 |
| ▾ / ▴ | 헤더 바로 접기 / 복원 |
| 헤더의 ⚙ | 설정: 언어, 테마(시스템/라이트/다크), 정확 감지, 알림음, 픽셀 배율, 온보딩 다시 보기 |

### 오피스 읽는 법

| 화면 | 의미 |
|---|---|
| 파란 러그, 머리 위 도구 태그, 켜진 모니터 | 작업 중. 태그 아래 점은 최근 도구 3개 |
| 노란 러그, 뒤돌아 손 흔드는 캐릭터, ❓ 말풍선, 타이머 | 선택 필요(권한 또는 질문) |
| 초록 ✓ 말풍선, 동작 없음 | 턴 종료 후 조용히 대기 |
| 빨간 러그, 깜빡이는 ! | 오류 |
| 옅은 파란 러그의 `↳ 이름` 캐릭터 | 옆 세션이 띄운 서브에이전트, 끝나면 사라짐 |
| 휴게실 소파 | 쉬는 세션(최근 24시간 이내) |
| 이름표 아래 게이지 | 컨텍스트 사용량 — 75% 노랑, 90% 빨강 깜빡임 |
| 👑 PM이 있는 금색 팀 블록 | PM 팀. PM에서 팀원으로 점선, 배지에 역할과 현재 태스크 |

**자동 / 2× / 3× / 4×**는 픽셀 배율, 종 아이콘은 알림음 토글입니다.

## 동작 원리

위젯은 5초마다 `orca worktree ps`와 `orca terminal list`로 세션 목록을, 2초마다 `orca terminal read --screen`으로 열린 터미널 화면을 읽습니다. 상태는 다음 순서로 결정됩니다.

1. **훅 이벤트**(정확, 정확 감지가 켜진 경우)
2. **터미널 화면**(추정)
3. **Orca 에이전트 상태**(대체)

<details>
<summary>세션 출처 (Orca 세션과 일반 터미널 세션)</summary>

| 세션 종류 | 발견 경로 | 채팅·PM 팀·인터럽트 |
|---|---|---|
| **Orca 세션** | `orca worktree ps` + 터미널 목록, 훅 이벤트로 보강 | Orca 터미널 |
| **터미널 세션**(iTerm2·Terminal.app·tmux에서 실행한 Claude Code) | Claude Code 훅 이벤트(`~/.roca/events.jsonl`) + 트랜스크립트 메타(`/rename` 또는 AI 제목·마지막 메시지·컨텍스트·브랜치) | tmux 패널(`send-keys` / `capture-pane`), 또는 `claude` 프로세스로 찾은 iTerm2 / Terminal.app 탭(AppleScript). 종료된 세션은 클릭하면 `claude --resume`으로 다시 열립니다 |

두 종류는 훅 스크립트가 기록하는 `TERM_PROGRAM` 값(`Orca` / `iTerm.app` / `tmux` / `Apple_Terminal`)으로 구분되어 한 목록에 함께 나옵니다. Orca가 없으면 훅만이 세션 출처가 되며, 이때 대시보드에 배너가 표시되고 정확 감지가 꺼져 있으면 버튼으로 바로 켤 수 있습니다.
</details>

<details>
<summary>훅 기반 정확 감지</summary>

정확 감지를 켜면 이 Mac에 설치된 모든 에이전트 CLI에 위젯 훅이 추가됩니다: `~/.claude/settings.json`(Claude Code), `~/.gemini/settings.json`(Gemini CLI), `~/.codex/hooks.json`(Codex CLI). 기존 훅은 보존되고 이전 파일은 `~/.roca/`에 백업됩니다. 나중에 설치한 CLI는 다음 위젯 시작 때 자동으로 포함됩니다. 훅 스크립트 `~/.roca/hook.sh`는 이벤트를 `~/.roca/events.jsonl`에 한 줄씩 덧붙이고 즉시 종료하며, 위젯이 이 파일을 감시합니다. Claude Code는 훅 설정을 즉시 다시 읽으므로 실행 중인 세션에도 적용됩니다. 끄면 위젯 항목만 제거됩니다.

| 훅 이벤트 | 위젯 상태 |
|---|---|
| `UserPromptSubmit`, `PreToolUse`(도구명·대상 기록), `PostToolUse` | 작업 중 |
| `Stop` | 대기(10분 후 완료) |
| `PermissionRequest`, `Notification`(`permission_prompt`, `agent_needs_input`, `elicitation_*`), `PreToolUse(AskUserQuestion)` | 선택 필요 |
| `SubagentStart` / `SubagentStop`, 서브에이전트 안의 `PreToolUse` | 서브에이전트 등장·도구 표시·퇴장 |
| `SessionEnd` | 완료 |

이벤트는 `cwd`와 워크트리 경로로 세션에 매칭됩니다. 훅 데이터가 없는 세션(다른 에이전트, 훅 미설치)은 화면 판독으로 동작합니다.
</details>

<details>
<summary>화면 기반 판별</summary>

마지막 `❯` 프롬프트 줄을 기준으로 그 위의 첫 의미 있는 줄을 봅니다(들여쓰기된 안내줄과 상태 표시줄은 건너뜀).

| 화면 | 상태 |
|---|---|
| `· Working… (1m 14s · ↓ 3.8k tokens)` 같은 스피너 줄, `esc to interrupt` | 작업 중 |
| 스피너 없는 `⏺` 응답 | 대기, 화면이 10분간 그대로면 완료 |
| 10분 이내의 `✻ Worked for 22s · done 2:34 PM` | 대기 |
| 같은 줄이 10분을 넘었거나 다른 날짜 | 완료 |
| `❯` 표시가 붙은 번호 선택지, `Do you want …` | 선택 필요 |
| 프롬프트가 없는 셸 터미널 | Orca 상태 |

시각은 영문·한국어 형식을 모두 해석합니다. 같은 화면에서 서브에이전트 패널(`⏺ main` 아래 `◯ 이름  설명  17s · ↓ 30.5k tokens`)과 상태 표시줄의 컨텍스트 비율도 읽습니다.
</details>

<details>
<summary>PM 팀</summary>

팀원에게 가는 모든 지시에는 팀 브리프 전체(목표, 범위, 결정 사항, 팀원별 산출물, 완료 조건, 금지 사항)가 동봉되어, 세션이 길어지거나 컨텍스트가 압축돼도 PM의 문맥이 유지됩니다. 팀원은 `REPORT_START … REPORT_END` 블록으로 보고하도록 요청받고, 팀원이 끝나면 위젯이 보고를 모아 PM에게 다음 단계를 묻습니다(기본은 승인 창, 자동 진행 가능, 라운드 상한 12). 팀 배치와 로그는 `~/.roca/teams.json`에 저장됩니다.
</details>

## 개발

```bash
npm run dev          # NODE_ENV=development로 실행
npm run dist         # dist/에 arm64·x64 DMG 빌드
```

| 환경 변수 | 효과 |
|---|---|
| `ROCA_START_PAGE=office` | 지정 탭으로 시작. `office-demo`는 가짜 세션 12개(서브에이전트·선택 필요·팀)를 렌더. `,en` / `,ko`로 언어 지정 |
| `ROCA_SHOT=/path/shot.png` | 8초·13.5초·24초 시점에 `shot-1.png` … 로 캡처 |
| `ROCA_DEBUG=1` | 터미널 읽기·렌더러 콘솔 로그 출력 |
| `ROCA_HOOKS_INSTALL=1` | 시작 시 훅 등록 |
| `ROCA_ORCA_BIN=/path/orca` | Orca CLI 경로 강제 |

```
main.mjs        Electron 메인: Orca CLI 브리지, 훅 설치/감시, 팀 저장, IPC
preload.cjs     window.orca로 노출되는 컨텍스트 브리지
widget.html     단일 파일 프론트엔드(HTML + CSS + JS); 오피스 렌더러와 팀 기능
assets/pixel/   스프라이트와 가구(CREDITS.md 참고)
assets/fonts/   Galmuri9 픽셀 폰트(OFL)
```

## 문제 해결

- **세션 목록이 비어 있음** — 위젯은 `orca`를 `/usr/local/bin`, `/opt/homebrew/bin`, `/Applications/Orca.app/Contents/Resources/bin`에서 찾습니다. 호출이 실패하면 빨간 배너가 원인을 알려 줍니다. Orca 앱이 실행 중인지, 터미널에서 `orca --version`이 되는지 확인하고, 필요하면 `sudo ln -s /Applications/Orca.app/Contents/Resources/bin/orca /usr/local/bin/orca`를 실행하세요.
- **Orca 1.4 미만** — 화면 판독과 채팅에 `terminal read --screen`과 `--json`이 필요합니다. 배너가 업데이트를 안내합니다.
- **"터미널 보기"나 메시지 전송이 동작하지 않음** — macOS가 AgentDesk의 iTerm2 / Terminal 제어(자동화 권한)를 한 번 묻습니다. **시스템 설정 → 개인정보 보호 및 보안 → 자동화**에서 허용하세요. 허용하지 않아도 상태는 읽지만 터미널 탭 전환과 입력은 되지 않습니다.
- **상태가 이상해 보임** — 정확 감지를 켜세요. 화면 판독은 Claude Code TUI 문구에 의존하지만 훅은 그렇지 않습니다.

## 크레딧

- 가구와 캐릭터 시트: [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) (MIT, Pablo De Lucca)
- 캐릭터 원본: JIK-A-4의 [Metro City Free Topdown Character Pack](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack) (CC0)
- 픽셀 폰트: quiple의 [Galmuri](https://github.com/quiple/galmuri) (SIL Open Font License 1.1)

## 기여

이슈와 풀 리퀘스트를 환영합니다. [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

## 라이선스

[MIT](LICENSE)
