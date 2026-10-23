# 릴리스와 코드 서명

AgentDesk 설치 파일은 `v*` 태그를 푸시하면 GitHub Actions(`.github/workflows/build.yml`)가 macOS·Linux·Windows 에서 만들고 GitHub Release 에 올립니다. 서명은 선택 사항입니다. 아래 GitHub Secrets 가 모두 있으면 서명하고, 하나라도 없으면 지금처럼 서명 없이(macOS 는 ad-hoc 서명) 빌드합니다.

| 플랫폼 | Secrets 가 모두 있을 때 | 없을 때 |
|---|---|---|
| macOS | Developer ID 서명, hardened runtime, Apple 공증, 공증 티켓 스테이플 | ad-hoc 서명(`scripts/adhoc-sign.cjs`), 공증 없음 |
| Windows | Authenticode 서명(signtool) | 서명 없음 |
| Linux | 서명하지 않습니다 | 같음 |

## 1. 준비할 것 (macOS)

1. **Apple Developer Program 계정**을 준비합니다. 개인 계정과 조직 계정 모두 됩니다. 연회비가 있습니다.
2. **Developer ID Application 인증서**를 만듭니다.
   - Xcode → Settings → Accounts → Manage Certificates → `+` → "Developer ID Application" 을 고릅니다. 또는 developer.apple.com 의 Certificates 화면에서 CSR 을 올려 발급받습니다.
   - 키체인 접근에서 인증서와 개인 키를 함께 선택하고 `.p12` 로 내보냅니다. 내보낼 때 정한 암호가 `CSC_KEY_PASSWORD` 입니다.
   - `.p12` 를 base64 문자열로 바꿉니다. 이 문자열이 `CSC_LINK` 입니다.

     ```sh
     base64 -i DeveloperID.p12 | pbcopy
     ```

3. **공증용 자격 증명**을 만듭니다. 이 저장소의 CI 는 Apple ID 방식을 씁니다.
   - appleid.apple.com → 로그인 및 보안 → 앱 암호에서 앱 전용 암호를 만듭니다. 이 값이 `APPLE_APP_SPECIFIC_PASSWORD` 입니다.
   - Apple ID 이메일이 `APPLE_ID` 입니다.
   - developer.apple.com → Membership 에 표시되는 10자리 Team ID 가 `APPLE_TEAM_ID` 입니다.
   - App Store Connect API 키(.p8)를 쓰고 싶다면 electron-builder 가 `APPLE_API_KEY`·`APPLE_API_KEY_ID`·`APPLE_API_ISSUER` 도 지원합니다. 다만 그 경우 `build.yml` 의 "Signing mode" 조건과 env 를 그 이름으로 바꿔야 합니다.

## 2. 준비할 것 (Windows, 선택)

1. 코드 서명 인증서를 `.pfx` 파일로 준비합니다. 2023년 6월 이후 발급되는 OV·EV 인증서는 대부분 하드웨어 토큰이나 클라우드 HSM 에만 들어 있어서 `.pfx` 로 내보낼 수 없습니다. 그런 인증서는 이 워크플로의 `.pfx` 방식으로 쓸 수 없으므로, Azure Trusted Signing(electron-builder `win.azureSignOptions`) 같은 방식을 따로 연결해야 합니다.
2. `.pfx` 를 base64 로 바꾼 값이 `WIN_CSC_LINK`, 암호가 `WIN_CSC_KEY_PASSWORD` 입니다.

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("codesign.pfx")) | Set-Clipboard
   ```

3. 서명해도 SmartScreen 평판이 쌓이기 전까지는 "Windows의 PC 보호" 경고가 한동안 남을 수 있습니다.

## 3. GitHub Secrets 등록

저장소 → Settings → Secrets and variables → Actions → New repository secret 에서 아래 이름으로 등록합니다. 값은 채팅·이슈·커밋에 붙여 넣지 말고 이 화면에만 입력합니다.

| 이름 | 내용 | 필요한 플랫폼 |
|---|---|---|
| `CSC_LINK` | Developer ID Application `.p12` 의 base64 | macOS |
| `CSC_KEY_PASSWORD` | `.p12` 암호 | macOS |
| `APPLE_ID` | 공증에 쓸 Apple ID 이메일 | macOS |
| `APPLE_APP_SPECIFIC_PASSWORD` | 앱 전용 암호 | macOS |
| `APPLE_TEAM_ID` | 10자리 Team ID | macOS |
| `WIN_CSC_LINK` | 코드 서명 `.pfx` 의 base64 | Windows |
| `WIN_CSC_KEY_PASSWORD` | `.pfx` 암호 | Windows |

macOS 는 다섯 개, Windows 는 두 개가 모두 있어야 서명합니다. 태그 빌드에서 한 플랫폼의 시크릿이 일부만 있으면 설정 오류로 보고 빌드를 실패시킵니다. 인증서만 있고 공증 자격 증명이 없으면 Gatekeeper 가 막는 앱이 나오기 때문입니다. 태그가 아닌 빌드(workflow_dispatch)는 일부만 있으면 서명 없이 빌드합니다.

서명 없는 릴리스가 절대 나가지 않게 하려면 저장소 → Settings → Secrets and variables → Actions → Variables 에 `REQUIRE_SIGNING` 변수를 `true` 로 만듭니다. 그러면 macOS·Windows 작업은 시크릿이 없을 때 실패합니다. Linux 는 서명하지 않으므로 이 변수의 영향을 받지 않습니다.

## 4. 릴리스 절차

1. `package.json` 의 `version` 을 올리고 커밋합니다.
2. `git tag v0.2.8 && git push origin v0.2.8` 처럼 태그를 푸시합니다.
3. Actions 의 "Build installers" 실행 결과에서 각 작업의 "Signing mode" 줄을 확인합니다. `mac`·`win` 이면 서명 빌드이고 `none` 이면 서명 없는 빌드입니다.
4. 서명 빌드는 다음 검증 단계가 자동으로 돌고, 하나라도 실패하면 릴리스가 만들어지지 않습니다.
   - macOS: `codesign --verify --deep --strict`, `spctl -a -vv -t exec`, `xcrun stapler validate`
   - Windows: `Get-AuthenticodeSignature` 결과가 `Valid`
5. 공증은 Apple 서버 상태에 따라 수 분에서 수십 분이 걸립니다. 작업 시간 제한은 60분입니다.

## 5. Electron 퓨즈와 서명 순서

패키지를 만든 직후 afterPack 단계(`scripts/after-pack.cjs`)에서 Electron 퓨즈를 바꿉니다. 퓨즈를 바꾸면 실행 파일 내용이 달라져서 그 전에 한 서명이 깨집니다. 그래서 순서는 항상 **퓨즈 설정 → 서명**입니다.

1. `scripts/after-pack.cjs` 가 퓨즈를 설정합니다.
2. 같은 단계에서 Developer ID 가 없으면 `scripts/adhoc-sign.cjs` 가 ad-hoc 서명합니다.
3. Developer ID 가 있으면 electron-builder 가 afterPack 다음에 서명하고 공증합니다.

| 퓨즈 | macOS | Linux | Windows | 이유 |
|---|---|---|---|---|
| RunAsNode | 끔 | 끔 | 켬 | Windows 에 node.exe 가 없을 때 승인·가드레일 훅을 AgentDesk.exe 의 Node 모드로 실행합니다. macOS·Linux 의 도우미 스크립트(브리핑, 슬랙 창구, 세션 노트)는 시스템 node 가 없으면 Electron 유틸리티 프로세스로 실행합니다 |
| EnableNodeOptionsEnvironmentVariable | 끔 | 끔 | 끔 | `NODE_OPTIONS` 로 코드를 주입하지 못하게 합니다 |
| EnableNodeCliInspectArguments | 끔 | 끔 | 끔 | `--inspect` 디버거 연결을 막습니다 |
| EnableEmbeddedAsarIntegrityValidation | 켬 | 해당 없음 | 켬 | 바뀐 app.asar 는 열지 않습니다. Electron 이 Linux 에서는 지원하지 않습니다 |
| OnlyLoadAppFromAsar | 켬 | 켬 | 켬 | 앱 코드는 app.asar 에서만 읽습니다 |

빌드 결과의 퓨즈 상태는 다음 명령으로 확인합니다.

```sh
npx @electron/fuses read --app /tmp/agentdesk-build/mac-arm64/AgentDesk.app
```

## 6. 앱 안 업데이트와 서명의 관계

- 앱 안의 [받기]는 GitHub Release 에서 이 PC 에 맞는 설치 파일을 고르고, 릴리스의 SHA-256 값과 대조한 뒤, 사용자가 확인해야 엽니다. 이 흐름은 서명 여부와 상관없이 같습니다.
- 받은 설치 파일에는 서명 빌드든 아니든 항상 "인터넷에서 받은 파일" 표시(macOS quarantine, Windows Zone.Identifier)를 붙입니다. 그래서 SHA-256 대조와 별개로 Gatekeeper·SmartScreen 이 파일을 한 번 더 검사합니다. 공증된 설치 파일은 이 검사를 경고 없이 통과합니다.
- 서명 빌드에는 CI 가 `package.json` 에 `agentdeskSigned`(`mac` 또는 `win`)를 넣습니다. 이 값은 다운로드 확인 대화상자에 "공증된 설치 파일입니다"(macOS) 또는 "서명된 설치 파일입니다"(Windows) 한 줄을 표시하는 데에만 씁니다. 같은 파이프라인이 만든 릴리스이므로 설치 파일도 같은 방식으로 서명되어 있습니다.
- Linux 는 실행 형식에 맞는 파일을 받습니다. AppImage 로 실행 중이면 AppImage 를, deb 로 설치했으면 같은 아키텍처의 deb 를 받습니다. 릴리스에 그 아키텍처의 deb 가 없으면 AppImage 를 받습니다.

## 7. 처음 서명 빌드로 바꿀 때 확인할 것

- **키체인에 저장한 값**: 팀 키(`~/.agentdesk/team-key`)와 Jira 로그인(`~/.agentdesk/jira-oauth.enc`)은 Electron safeStorage 로 암호화되어 있습니다. ad-hoc 서명 앱에서 Developer ID 서명 앱으로 처음 업데이트하면 macOS 가 키체인 접근을 다시 묻거나, 복호화에 실패해 Jira 를 다시 로그인해야 할 수 있습니다. 첫 서명 릴리스 전에 ad-hoc 빌드에서 서명 빌드로 덮어써 보고 두 파일이 읽히는지 확인합니다.
- **AppleScript 권한**: hardened runtime 에서는 터미널 전환·입력에 `com.apple.security.automation.apple-events` 엔타이틀먼트와 `NSAppleEventsUsageDescription` 문구가 필요합니다. 둘 다 들어 있지만(`build/entitlements.mac.plist`, `package.json` 의 `extendInfo`), 서명이 바뀌면 macOS 가 자동화 권한을 다시 묻습니다.
- **엔타이틀먼트 범위**: AgentDesk 는 샌드박스를 쓰지 않으므로 네트워크·파일 접근에는 엔타이틀먼트가 필요 없습니다. `build/entitlements.mac.plist` 에는 V8 JIT(`allow-jit`)와 Apple Events 두 가지만 있습니다. 첫 서명 빌드에서 앱·도우미 프로세스·Node 모드 스크립트(브리핑, 슬랙 창구)가 실행되는지 확인하고, 실행되지 않으면 이 파일부터 봅니다.
- **퓨즈 적용 후 실행**: 퓨즈를 켠 첫 릴리스에서 앱이 뜨는지, 브리핑과 슬랙 창구가 시스템 node 없이도 도는지 확인합니다. asar 무결성 검사에 걸리면 앱이 시작하자마자 종료됩니다.
- **Windows 실기기 수동 검증**: Windows PC 에서 가드레일을 켜고 차단 규칙(예: `rm -rf ~`)에 걸리는 명령을 Claude Code 에 시켜, 위젯에 기록이 남고 Claude Code 가 확인을 묻거나 거부하는지 직접 확인합니다. node.exe 가 있는 PC 와 없는 PC 를 모두 시험합니다. 훅이 조용히 실패하면 설정 화면의 "마지막 훅 요청 시각"(`lastHookAt`)이 비어 있습니다. 위젯 승인도 같은 방법으로 확인합니다.
- **승인 파일 보호(Windows)**: 토큰(`perm-token`)과 주소(`perm-addr`) 파일은 macOS·Linux 에서 0600 권한으로 만듭니다. Windows 는 이 권한 비트를 무시하므로, 두 파일이 들어 있는 `%USERPROFILE%\.roca\perm` 의 사용자 프로필 ACL 이 다른 사용자의 접근을 막습니다.
- **DMG 의 `처음 실행.command`**: 공증되지 않은 앱의 격리 속성을 지우는 보조 스크립트입니다. 서명 빌드에서는 필요 없으므로, 서명 릴리스가 안정되면 `package.json` 의 `dmg.contents` 에서 빼고 README 의 우회 안내를 줄입니다.

## 8. 로컬에서 빌드 설정만 확인하기

서명 없이 패키지 디렉터리만 만들어 설정을 확인할 수 있습니다. 결과는 `dist/` 대신 다른 곳에 두는 편이 안전합니다.

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir --arm64 -c.directories.output=/tmp/agentdesk-build
codesign -dv /tmp/agentdesk-build/mac-arm64/AgentDesk.app   # Signature=adhoc 이면 서명 없는 경로
```

앱 아이콘은 `assets/icon.png`(512×512)이고 `npm run icon`(`scripts/make-icon.mjs`)으로 다시 만듭니다. electron-builder 가 이 PNG 로 macOS `.icns` 와 Windows `.ico` 를 만듭니다.
