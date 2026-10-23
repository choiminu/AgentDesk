# Jira 연결 설정 / Jira setup

[한국어](#한국어) · [English](#english) · [README](../README.ko.md) · [README (English)](../README.md)

---

## 한국어

AgentDesk의 Jira 탭은 Atlassian OAuth 2.0(3LO)으로 Jira Cloud에 직접 연결합니다. AgentDesk는 공용 OAuth 앱을 함께 배포하지 않으므로, 사용자가 Atlassian 개발자 콘솔에서 자기 OAuth 앱을 하나 만들고 그 Client ID와 Client Secret을 AgentDesk에 넣어야 합니다. 이 문서의 `your-site.atlassian.net`은 자리표시자입니다.

### 1. OAuth 2.0(3LO) 앱 만들기

1. [developer.atlassian.com/console/myapps](https://developer.atlassian.com/console/myapps/)에 Atlassian 계정으로 로그인합니다.
2. **Create**에서 **OAuth 2.0 integration**을 고르고, 앱 이름(예: `AgentDesk`)을 정해 만듭니다.

### 2. 권한(스코프) 추가

앱의 **Permissions**에서 **Jira API**를 추가하고, 다음 세 스코프를 켭니다.

| 스코프 | AgentDesk가 쓰는 곳 |
|---|---|
| `read:jira-work` | 프로젝트·티켓 목록, 티켓 상세, 보드 검색 |
| `read:jira-user` | 담당자 이름·아바타, 내 계정(`/myself`) |
| `write:jira-work` | REPORT 댓글 등록. AgentDesk가 Jira에 쓰는 동작은 댓글 등록 하나뿐입니다 |

AgentDesk는 로그인 요청에 이 세 스코프와 함께 `offline_access`를 넣어 리프레시 토큰을 받습니다. 그래서 한 번 로그인하면 액세스 토큰이 만료되어도 다시 로그인하지 않아도 됩니다.

Jira Software(보드) 스코프는 요청하지 않습니다. 칸반 보드는 먼저 프로젝트 보드의 열 설정을 읽어 보고, 권한이 없다는 응답(401·403)을 받으면 그 뒤로는 묻지 않고 프로젝트 상태로 열을 만듭니다.

### 3. 콜백 URL 등록

앱의 **Authorization** → **OAuth 2.0 (3LO)** 에서 **Callback URL**에 다음 값을 그대로 넣고 저장합니다.

```
http://localhost:47391/callback
```

- 포트 `47391`은 코드에 고정된 값이며 바꿀 수 없습니다. 콘솔에 다른 포트를 등록하면 로그인이 실패합니다.
- 로그인하는 동안 AgentDesk가 이 컴퓨터의 `127.0.0.1:47391`(IPv6가 있으면 `[::1]:47391`도)에서 콜백을 한 번 받고 바로 닫습니다. 다른 프로그램이 이 포트를 쓰고 있으면 "포트 47391이(가) 이미 사용 중입니다"가 나옵니다.

### 4. Client ID·Secret 복사

앱의 **Settings**에서 **Client ID**와 **Secret**을 복사합니다. Secret은 비밀번호처럼 다루고, 채널이나 저장소에 올리지 마세요.

### 5. AgentDesk에서 로그인

1. AgentDesk의 **Jira** 탭을 엽니다. 맨 위 연결 상자에 "OAuth 연결 안 됨"이 보이면 **연결 설정**을 누릅니다.
2. Client ID와 Client Secret을 붙여 넣고 **저장**을 누릅니다. 저장한 뒤에는 Secret 칸에 "Client Secret 저장됨 — 바꿀 때만 입력"이 표시됩니다.
3. **Atlassian으로 로그인**을 누르면 브라우저가 열립니다. 5분 안에 Atlassian 동의 화면에서 접근을 허용합니다.
4. 브라우저에 "AgentDesk에 연결되었습니다. 이 창을 닫아도 됩니다."가 나오면 창을 닫습니다. Jira 탭 연결 상자에 "OAuth 연결됨: https://your-site.atlassian.net"이 표시됩니다.

계정이 여러 Jira 사이트에 접근할 수 있으면 연결 상자에 사이트 선택 목록이 나옵니다. 고른 사이트는 저장되어 다음 실행에도 유지됩니다.

### `AGENTDESK_JIRA_SITE` 환경 변수

선택 사항입니다. 계정이 여러 Jira 사이트에 접근할 수 있을 때, 아직 고른 사이트가 없으면 이 값과 URL이 같은 사이트를 먼저 고릅니다(끝의 `/`와 대소문자는 무시합니다). 값이 없거나 맞는 사이트가 없으면 목록의 첫 번째 Jira 사이트를 고릅니다. 이미 고른 사이트가 있으면 그 사이트를 유지합니다.

```bash
AGENTDESK_JIRA_SITE=https://your-site.atlassian.net npm start
```

### 토큰 저장 방식

- Client ID, Client Secret, 액세스 토큰, 리프레시 토큰, 고른 사이트는 모두 `~/.agentdesk/jira-oauth.enc` 한 파일에 저장됩니다. 이 파일은 Electron safeStorage(macOS 키체인 등 OS 암호화)로 암호화되며 권한은 600입니다.
- 토큰과 Secret은 메인 프로세스에만 있고, 위젯 화면(렌더러)·로그·오류 메시지로 나가지 않습니다. 화면은 Client ID, Secret 저장 여부, 사이트 정보만 받습니다.
- 리프레시 토큰은 갱신할 때마다 바뀝니다. AgentDesk는 갱신을 한 번에 하나씩 하고, 새 토큰을 파일에 저장한 뒤에 사용합니다.
- OS 암호화 저장소를 쓸 수 없는 환경(키링이 없는 Linux 등)에서는 OAuth 정보를 저장하지 않으며, 연결 상자에 "이 시스템에서는 암호화 저장소를 쓸 수 없어 OAuth를 사용할 수 없습니다."가 표시됩니다. 이때는 아래 Orca 폴백을 씁니다.
- 다른 Client ID를 저장하면 이전 앱의 토큰은 지워지고 다시 로그인해야 합니다.

### 연결 끊기

연결 상자의 **로그아웃**을 누르고 확인하면 `~/.agentdesk/jira-oauth.enc` 파일을 지웁니다. 토큰뿐 아니라 저장한 Client ID와 Secret도 함께 지워지므로, 다시 연결하려면 4~5단계를 반복합니다. Atlassian 쪽에 남은 앱 승인은 Atlassian 계정 설정에서 따로 취소할 수 있습니다.

### Orca 폴백

OAuth로 로그인하지 않았으면 Jira 탭은 Orca CLI의 Jira 연결(`orca jira connection`·`list`·`search`·`issue`·`comment add`)을 씁니다. Orca 설정 → Jira에서 사이트를 연결해 두면 티켓 목록·상세 보기·REPORT 댓글 등록이 동작합니다. 칸반 보드(프로젝트 선택, 열, 담당자 칩)는 OAuth로 연결했을 때만 동작합니다. 두 경로 모두 댓글은 보내기 직전에 메인 프로세스에서 마스킹합니다.

### 아침 브리핑의 `~/.agentdesk/jira.json`과의 차이

아침 브리핑(소스 체크아웃의 `recall/brief.mjs`)은 Jira 연결을 따로 고릅니다.

- `~/.agentdesk/jira.json`이 있으면 브리핑 스크립트가 그 파일(`baseUrl`, `email`, API 토큰 `token`, 선택 `jql`)로 직접 Jira를 읽습니다. 형식은 `recall/jira.example.json`에 있습니다. 이 파일은 평문이며 OAuth와 관계없습니다.
- 그 파일이 없고 Jira 탭이 OAuth로 연결되어 있으면, 메인 프로세스가 OAuth로 브리핑용 티켓(내 담당, 미완료, 오늘까지 마감이거나 우선순위 Highest·High, 최대 15개)을 읽어 권한 600 임시 파일로 브리핑 스크립트에 넘깁니다. 브리핑 스크립트는 그 파일을 한 번 읽고 지웁니다.
- 둘 다 없으면 브리핑에 Jira 항목이 없습니다. Jira 탭만 쓴다면 `jira.json`을 만들 필요가 없습니다.

### 문제 해결

| 증상 | 원인과 조치 |
|---|---|
| "포트 47391이(가) 이미 사용 중입니다" | 다른 프로그램이나 다른 AgentDesk 창이 포트를 쓰고 있습니다. 그 프로그램을 종료하고 다시 로그인합니다 |
| "로그인 시간이 초과되었습니다 (5분)" | 브라우저에서 5분 안에 동의를 마치지 못했습니다. 다시 **Atlassian으로 로그인**을 누릅니다 |
| 브라우저에 콜백 URL 불일치 오류 | 콘솔에 등록한 콜백 URL이 `http://localhost:47391/callback`과 정확히 같은지 확인합니다(`https`가 아니라 `http`, 끝에 `/` 없음) |
| "Atlassian이 로그인을 거부했습니다 (…)" | 동의 화면에서 거부했거나 앱 권한 설정에 문제가 있습니다. Permissions에 Jira API 세 스코프가 있는지 확인합니다 |
| "로그인 응답의 state가 일치하지 않습니다." | 이전 로그인 창의 응답이 들어왔습니다. 열린 Atlassian 창을 모두 닫고 다시 로그인합니다 |
| "이 계정으로 접근할 수 있는 Jira 사이트가 없습니다." | 로그인한 Atlassian 계정이 Jira Cloud 사이트에 접근할 수 없습니다. 계정과 사이트 권한을 확인합니다 |
| "Client ID 형식이 올바르지 않습니다." | 콘솔 Settings의 Client ID를 공백 없이 다시 붙여 넣습니다 |
| 암호화 저장소를 쓸 수 없다는 안내 | OS 키링이 없거나 잠겨 있습니다. Linux에서는 키링 서비스(gnome-keyring 등)를 켜거나, Orca 폴백을 씁니다 |
| 보드 열이 Jira 보드와 다름 | 보드 설정을 읽을 권한이 없어 프로젝트 상태로 열을 만들었습니다. 보드의 **열 편집**으로 열 순서를 바꾸거나 열을 숨길 수 있습니다. 이 설정은 이 PC의 AgentDesk에만 저장되고 Jira 보드 설정은 바꾸지 않습니다 |
| 업데이트 뒤 다시 로그인하라고 나옴 | 저장 파일을 복호화하지 못하면 연결되지 않은 상태로 보입니다. 4~5단계로 다시 연결합니다 |

---

## English

The Jira tab of AgentDesk connects directly to Jira Cloud with Atlassian OAuth 2.0 (3LO). AgentDesk does not ship a shared OAuth app, so you create your own OAuth app in the Atlassian developer console and give AgentDesk its Client ID and Client Secret. `your-site.atlassian.net` in this document is a placeholder.

### 1. Create an OAuth 2.0 (3LO) app

1. Sign in to [developer.atlassian.com/console/myapps](https://developer.atlassian.com/console/myapps/) with your Atlassian account.
2. Under **Create**, choose **OAuth 2.0 integration**, give the app a name (for example `AgentDesk`) and create it.

### 2. Add permissions (scopes)

In the app's **Permissions**, add **Jira API** and enable these three scopes.

| Scope | Used by AgentDesk for |
|---|---|
| `read:jira-work` | Project and ticket lists, ticket details, board search |
| `read:jira-user` | Assignee names and avatars, your own account (`/myself`) |
| `write:jira-work` | Posting REPORT comments. Posting a comment is the only write AgentDesk makes to Jira |

AgentDesk adds `offline_access` to these three scopes in its sign-in request to get a refresh token, so you stay signed in after the access token expires.

AgentDesk does not request Jira Software (board) scopes. The Kanban board first tries to read the project board's column configuration; on a permission error (401 or 403) it stops asking and builds the columns from the project statuses.

### 3. Register the callback URL

Under the app's **Authorization** → **OAuth 2.0 (3LO)**, enter exactly this **Callback URL** and save:

```
http://localhost:47391/callback
```

- Port `47391` is fixed in the code and cannot be changed. A different port registered in the console makes the sign-in fail.
- During sign-in, AgentDesk receives the callback once on `127.0.0.1:47391` of this computer (and on `[::1]:47391` when IPv6 is available) and closes it right away. If another program uses the port, you see a "port 47391 is already in use" error.

### 4. Copy the Client ID and Secret

In the app's **Settings**, copy the **Client ID** and the **Secret**. Treat the Secret like a password; never post it in a channel or a repository.

### 5. Sign in from AgentDesk

1. Open the **Jira** tab in AgentDesk. When the connection box at the top says "OAuth not connected", click **Connection**.
2. Paste the Client ID and Client Secret and click **Save**. After saving, the Secret field shows "Client Secret saved — type only to change it".
3. Click **Sign in with Atlassian**; your browser opens. Allow access on the Atlassian consent screen within 5 minutes.
4. When the browser says that AgentDesk is connected and the window can be closed, close it. The connection box shows "OAuth connected: https://your-site.atlassian.net".

If your account can see several Jira sites, the connection box shows a site picker. The chosen site is saved and kept across restarts.

### The `AGENTDESK_JIRA_SITE` environment variable

Optional. When your account can see several Jira sites and no site has been chosen yet, AgentDesk picks the site whose URL equals this value (a trailing `/` and letter case are ignored). Without it, or when no site matches, the first Jira site in the list is picked. A site already chosen is kept.

```bash
AGENTDESK_JIRA_SITE=https://your-site.atlassian.net npm start
```

### How tokens are stored

- The Client ID, Client Secret, access token, refresh token and the chosen site all live in one file, `~/.agentdesk/jira-oauth.enc`, encrypted with Electron safeStorage (OS encryption such as the macOS keychain), mode 600.
- Tokens and the Secret stay in the main process and never reach the widget screen (renderer), logs or error messages. The screen only receives the Client ID, whether a Secret is saved, and the site.
- The refresh token rotates on every refresh. AgentDesk refreshes one at a time and saves the new token to the file before using it.
- Where OS encryption is not available (for example Linux without a keyring), OAuth data is never saved and the connection box says that encrypted storage is not available, so OAuth cannot be used. Use the Orca fallback below instead.
- Saving a different Client ID drops the previous app's tokens; you have to sign in again.

### Disconnecting

**Sign out** in the connection box, after a confirmation, deletes `~/.agentdesk/jira-oauth.enc`. That removes not only the tokens but also the saved Client ID and Secret, so to connect again repeat steps 4 and 5. The app's authorization on the Atlassian side can be revoked separately in your Atlassian account settings.

### Orca fallback

When you are not signed in with OAuth, the Jira tab uses the Orca CLI's Jira connection (`orca jira connection`, `list`, `search`, `issue`, `comment add`). With a site connected in Orca Settings → Jira, the ticket list, ticket details and posting REPORT comments work. The Kanban board (project picker, columns, assignee chips) works only with OAuth. On both paths, comments are masked in the main process right before they are sent.

### How this differs from `~/.agentdesk/jira.json` for the morning briefing

The morning briefing (`recall/brief.mjs` in a source checkout) chooses its Jira connection separately.

- If `~/.agentdesk/jira.json` exists, the briefing script reads Jira itself with that file (`baseUrl`, `email`, an API token in `token`, optional `jql`). The format is in `recall/jira.example.json`. This file is plain text and unrelated to OAuth.
- If that file does not exist and the Jira tab is connected with OAuth, the main process reads the briefing tickets through OAuth (assigned to you, not done, due today or earlier or priority Highest or High, up to 15) and hands them to the briefing script in a temporary file with mode 600, which the script reads once and deletes.
- With neither, the briefing has no Jira section. If you only use the Jira tab, you do not need `jira.json`.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "port 47391 is already in use" | Another program or another AgentDesk window uses the port. Quit it and sign in again |
| Sign-in timed out (5 minutes) | The consent was not finished in the browser within 5 minutes. Click **Sign in with Atlassian** again |
| Callback URL mismatch error in the browser | Make sure the callback URL in the console is exactly `http://localhost:47391/callback` (`http`, not `https`; no trailing `/`) |
| Atlassian refused the sign-in | You declined on the consent screen, or the app's permissions are wrong. Check that the three Jira API scopes are in Permissions |
| The `state` of the sign-in response does not match | A response from an earlier sign-in window arrived. Close all Atlassian windows and sign in again |
| No Jira site is accessible with this account | The Atlassian account you signed in with cannot access a Jira Cloud site. Check the account and site permissions |
| The Client ID format is not valid | Paste the Client ID from the console's Settings again, without spaces |
| Encrypted storage is not available | There is no OS keyring, or it is locked. On Linux, run a keyring service (gnome-keyring or similar), or use the Orca fallback |
| Board columns differ from the Jira board | There was no permission to read the board configuration, so columns were built from project statuses. **Edit columns** on the board reorders or hides columns; this is stored in AgentDesk on this PC only and does not change the Jira board |
| Asked to sign in again after an update | If the stored file cannot be decrypted, AgentDesk shows as not connected. Connect again with steps 4 and 5 |

Some error messages from the sign-in code are in Korean only in the current version.
