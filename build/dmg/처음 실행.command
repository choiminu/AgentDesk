#!/bin/bash
# AgentDesk 처음 실행: DMG 의 앱을 /Applications 에 복사하고, macOS 격리 속성(사내 배포라 Apple 공증 없음)을 지운 뒤 엽니다.
# 터미널 창이 잠깐 열렸다 닫힙니다. 비밀번호는 묻지 않습니다(사용자 계정의 /Applications 쓰기 권한 사용).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/AgentDesk.app"
if [ -d "$HERE/AgentDesk.app" ] && [ "$HERE" != "/Applications" ]; then
  echo "AgentDesk.app 을 /Applications 에 복사합니다…"
  rm -rf "$APP" && cp -R "$HERE/AgentDesk.app" "$APP"
fi
if [ ! -d "$APP" ]; then echo "AgentDesk.app 을 찾지 못했습니다. 앱을 Applications 폴더로 끌어다 놓은 뒤 다시 실행하세요."; read -r -p "Enter 를 누르면 닫힙니다"; exit 1; fi
xattr -cr "$APP" || true
open "$APP"
echo "완료. 이 창은 닫아도 됩니다."
