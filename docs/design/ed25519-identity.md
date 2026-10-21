# AgentDesk 팀 공유: 팀원별 Ed25519 신원 설계 (0.2.2 → 0.2.3)

- 대상: `/Users/a-25-059/project/agentdesk-internal` (branch main, HEAD a05d381)
- 성격: 읽기 전용 분석과 설계입니다. 코드는 수정하지 않았습니다.
- 표기: 행 번호는 위 저장소 기준입니다. 근거가 없는 추론에는 [추정]을 붙였습니다.

---

## 1. 결론

### 권고안 A: 계층형(HMAC 유지, Ed25519 추가)

팀 토큰 HMAC은 지금처럼 "팀 소속 증명"과 값싼 1차 필터로 남깁니다. 그 위에 팀원별 Ed25519 서명을 요청과 응답 양쪽에 추가하고, 호출자 판정·위임 grant·메모 발신자·hello를 모두 "서명한 키의 지문(kid)"에 묶습니다.

이 방식을 고른 결정적 근거는 와이어 호환성입니다.

- 0.2.1 서버는 `x-ad-ts`, `x-ad-nonce`, `x-ad-sig`만 읽고 다른 헤더는 무시합니다(`team/peer.mjs:296`).
- 0.2.1 클라이언트는 응답의 `x-ad-sig`만 검증합니다(`team/peer.mjs:647`).
- 0.2.1 hello 처리는 본문의 name, port, instanceId만 읽습니다(`team/peer.mjs:491-494`).
- 0.2.1 `decodeInvite`는 JSON 안의 모르는 필드를 무시합니다(`team/peer.mjs:166-173`).

따라서 0.2.2를 0.2.1과 섞어 써도 통신이 끊기지 않습니다.

0.2.3 strict 모드에서는 grant·메모·원격 요청을 고정(pinned)된 키에만 허용합니다. 그러면 팀원을 목록에서 삭제하는 것만으로 그 사람의 권한이 즉시 끊기므로, 대안 B의 핵심 이점도 대부분 얻습니다.

### 대안 B: 토큰 완전 대체(키 명부만으로 소속 판정)

- 장점: 공유 비밀이 없으므로 초대 코드가 유출되어도 무해하게 만들 수 있습니다. 팀원별 축출이 자연스럽습니다.
- 단점: n² 지문 확인 또는 초대자가 서명하는 명부(roster) 배포를 새로 만들어야 합니다. 0.2.1과는 즉시 단절됩니다. 토큰이 없는 공격자의 요청에도 Ed25519 검증 비용을 치러야 합니다.
- 판단: 0.2.4 이후의 선택지로 남깁니다.

---

## 2. 현황 분석: 신원이 IP에 묶인 지점

| 지점 | 현재 동작 | 근거 |
|---|---|---|
| 원격 호출자 판정 | 요청 IP에 등록된 peers의 instanceId 목록을 호출자로 봅니다. 한 IP에 2명이 있으면 ambiguous로 처리합니다 | `team/peer.mjs:513-517`, `:554-555` |
| grant 배포 | `/v1/sessions` 응답에 `forInstances(caller.ids)`의 grant를 넣습니다. 따라서 IP를 장악하면 grant도 받습니다 | `team/peer.mjs:525-527`, `team/remote.mjs:195-198` |
| grant 사용 | `match(sid, grant, caller.ids)`가 IP 기반 id 집합과 대조합니다 | `team/peer.mjs:556`, `team/remote.mjs:200-206` |
| 메모 발신자 | 요청 IP와 port 힌트로 발신자를 결정합니다 | `team/peer.mjs:501-505` |
| hello | 요청 IP와 본문 port로 host를 만들고, instanceId는 본문의 자기 주장만 받습니다 | `team/peer.mjs:492-496` |
| 응답 진위 | 같은 토큰을 가진 누구든 유효한 응답을 만들 수 있습니다. 상대 신원은 응답 본문의 instanceId 비교로만 확인합니다 | `team/peer.mjs:647`, `main.mjs:1657-1661` |
| 신원 재확인 | 위임 대상은 1분마다 304 없이 전체 조회해 instanceId를 확인합니다. 그 사이에 틈이 남습니다 | `main.mjs:1646-1651` |
| 이동 판정 | 이전 주소에 서명된 ping을 보내 경합으로 판정합니다 | `team/peer.mjs:748-755`, `main.mjs:1613-1618` |
| nonce·속도 제한 | 버킷 키가 IP입니다 | `team/peer.mjs:273-290`, `:508` |
| 위임 가능 조건 | 같은 IP의 중복 항목, 같은 /24의 미식별 항목이 있으면 위임을 거부합니다 | `team/remote.mjs:101-114` |
| 자동 해제 | ambiguous, identity mismatch, unreachable, local network denied 사유가 IP 신원 재확인 목적입니다 | `team/remote.mjs:115-140` |
| 가이드 | "알려진 한계: IP 기준"을 명시합니다 | `docs/TEAM-GUIDE.md:146-148` |

### team.json 필드 보존 상황

- `editTeamJson`은 raw 객체를 그대로 유지한 채 다시 씁니다(`team/peer.mjs:105-111`).
- `upsertPeer`는 기존 항목을 `{...p}`로 복사합니다(`team/peer.mjs:128`).
- 그래서 0.2.1이 team.json을 다시 써도 `pubkey` 같은 새 필드가 남습니다. 0.2.2에서 0.2.1로 다운그레이드해도 키 정보가 사라지지 않습니다.
- 반면 `readTeamConfig`는 peers에서 name, host, instanceId만 남깁니다(`team/peer.mjs:81`). 0.2.2에서는 이 함수를 반드시 고쳐야 합니다.

### 성능 실측

설치된 AgentDesk.app(Electron 36.9.5, Node 22.19.0, BoringSSL)에서 `ELECTRON_RUN_AS_NODE=1`로 측정했습니다. 측정 스크립트는 같은 폴더의 `ed.mjs`입니다.

| 연산 | Electron 36.9.5 | Node 26.9 (OpenSSL 3.6.4) |
|---|---|---|
| Ed25519 서명 | 16.3 µs | 19.9 µs |
| Ed25519 검증 | 29.8 µs | 42.8 µs |
| JWK 공개키 가져오기 | 1.1 µs | 1.4 µs |
| HMAC-SHA256 | 0.9 µs | 1.2 µs |

팀원 10명이 3초마다 폴링한다고 가정하고, PC 한 대가 초당 처리하는 양을 추정했습니다.

- 나가는 요청은 초당 약 3.3건이며, 각 요청마다 서명 1회와 응답 검증 1회를 합니다.
- 들어오는 요청은 초당 약 3.3건이며, 각 요청마다 검증 1회와 응답 서명 1회를 합니다.
- 합계는 서명 약 6.7회와 검증 약 6.7회로, 약 0.31 ms/s입니다. CPU 점유율로는 약 0.03%입니다.
- 원격 화면 창 2개(1.5초 주기)를 더해도 0.05% 미만입니다.

토큰이 없는 공격자는 0.9 µs짜리 HMAC 단계에서 걸러지므로 Ed25519 검증까지 가지 않습니다. 토큰을 가진 공격자도 요청 1건에 약 30 µs가 들고, 서버의 `maxConnections` 50(`team/peer.mjs:620`)이 동시 처리 상한입니다.

---

## 3. 근본 원인

신원의 근원이 "토큰 소지자 중 그 IP에 있는 자"이기 때문에, 신원이 네트워크 계층(DHCP·ARP)의 약점을 그대로 물려받습니다.

- 토큰은 팀 전원이 공유하므로, 누가 보냈는지를 증명하지 못합니다.
- 응답 서명도 같은 토큰을 쓰므로, 클라이언트는 응답한 상대가 누구인지 확인하지 못합니다.
- instanceId는 자기 주장에 불과하며 비밀도 아닙니다. 비콘으로 공개되기 때문입니다(`team/discovery.mjs:14-15`).

---

## 4. 프로토콜 명세 (권고안 A)

### 4.1 키와 지문

- **키 형식**: Ed25519 키쌍을 씁니다. 공개키는 raw 32바이트이고, 와이어와 파일에는 base64url 43자(`pub`)로 적습니다. Node에서는 `createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" })`로 가져오며, Electron에서 동작하는 것을 확인했습니다.
- **kid**: `base64url(sha256(raw32))`(43자)입니다. 프로토콜 식별자로 씁니다.
- **표시용 지문**: `sha256(raw32)`를 base32(RFC4648, 패딩 없음)로 인코딩한 앞 20자를 4자씩 5묶음으로 표시합니다(예: `K7QM-3XPA-…`). 대소문자 혼동이 없어서 Slack이나 음성으로 대조하기 쉽습니다.
- **teamTag**: `HMAC-SHA256(token, "agentdesk-team-tag")`의 앞 16 hex입니다. 서명 입력에 넣어서, 같은 키를 쓰는 PC가 다른 팀에 다시 합류하더라도 한 팀의 서명이 다른 팀에서 재사용되지 않게 합니다.

### 4.2 요청 서명

기존 헤더 `X-AD-Ts`, `X-AD-Nonce`, `X-AD-Sig`(HMAC, v1 입력 문자열 그대로: `team/peer.mjs:256-258`)는 유지합니다. 아래 헤더를 추가합니다.

| 헤더 | 값 |
|---|---|
| `X-AD-Ver` | `2` |
| `X-AD-Kid` | 호출자 kid(43자) |
| `X-AD-To` | 대상 kid. 고정된 키를 알면 그 값이고, 모르면 `-`입니다 |
| `X-AD-KSig` | base64url(Ed25519 서명 64바이트), 86자 |

Ed25519 서명 입력은 UTF-8이고, 줄 사이를 LF로 연결하며, 마지막 줄 뒤에는 LF가 없습니다.

```
agentdesk-req-v2
<METHOD 대문자>
<host = 받는 PC의 ip:port>
<path (쿼리 포함, req.url 그대로)>
<ts>
<nonce>
<sha256hex(body)>
<callerKid>
<targetKid 또는 ->
<teamTag>
```

### 4.3 응답 서명

기존 HMAC `X-AD-Sig`(`team/peer.mjs:259-261`)는 유지합니다. `X-AD-Ver: 2`, `X-AD-Kid: <serverKid>`, `X-AD-KSig`를 추가합니다. 401·304·4xx 응답도 지금처럼 모두 서명합니다(`team/peer.mjs:458-465`).

```
agentdesk-res-v2
<status>
<host>
<ts>
<nonce>
<sha256hex(body)>
<serverKid>
<callerKid>
<teamTag>
```

### 4.4 서버 검증 순서

이 순서는 `verifyRequest`(`team/peer.mjs:293-303`)를 확장한 것입니다.

1. 헤더 형식을 확인합니다.
2. ts가 ±120초 이내인지 확인합니다.
3. Host가 이 PC의 주소와 포트인지 확인합니다(기존 `team/peer.mjs:481`).
4. HMAC을 검증합니다.
5. `X-AD-Ver`가 2이면 kid 형식을 확인합니다. `X-AD-To`가 `-`가 아닌데 내 kid와 다르면 401 `wrong peer`로 거절합니다.
6. 공개키를 찾습니다.
   - 우선 peers에서 `pubkey`의 kid가 일치하는 항목을 찾습니다.
   - 경로가 `/v1/hello`이면 본문의 `pubkey`로 kid를 계산하고, 헤더 kid와 일치해야 합니다.
   - 둘 다 아니고 경로가 `/v1/ping` 또는 `/v1/sessions`이면 "미등록 키"로 진행합니다(4.7절 참고).
   - 그 밖의 경우는 401 `unknown key`로 거절합니다.
7. Ed25519 서명을 검증합니다.
8. nonce guard를 검사합니다. 버킷 키는 v2 요청이면 kid이고, v1 요청이면 IP입니다. `team/peer.mjs:273-290`에서 `ip` 인자 자리를 일반 키로 바꾸면 됩니다.

### 4.5 다운그레이드 금지 규칙

- **서버 측**: `pubkey`가 고정된 peer의 IP에서 HMAC만 달린 요청이 오면, 그 요청을 그 peer로 귀속하지 않습니다. 메모는 403으로 거절하고, grant와 safety는 내주지 않습니다.
- **클라이언트 측**: `pubkey`를 고정한 peer의 응답에 `X-AD-KSig`가 없거나 검증에 실패하면 `bad signature`로 처리합니다. 기존의 `team/peer.mjs:663`, `:678`, `:696` 경로를 그대로 탑니다.

### 4.6 초대 코드

| 버전 | 접두사 | 본문 |
|---|---|---|
| 0.2.2 | `agentdesk-team:v1:` 유지 | `{ v: 2, token, inviter: { name, host, instanceId, pubkey } }` |
| 0.2.3 | `agentdesk-team:v2:` | 같은 JSON |

- 0.2.2에서 접두사를 v1로 유지하는 이유는, 0.2.1의 `decodeInvite`가 v2 접두사를 "not an AgentDesk invite code"로 거절하기 때문입니다(`team/peer.mjs:168`). JSON 안의 모르는 필드는 무시하므로(`team/peer.mjs:170-173`), 0.2.1 사용자도 0.2.2가 만든 코드로 합류할 수 있습니다.
- 0.2.3에서는 접두사를 v2로 바꿔서, 구버전이 명확한 오류로 실패하게 합니다. 0.2.3의 `decodeInvite`는 두 접두사를 모두 받되, `pubkey`가 없으면 거절합니다.
- 합류하는 쪽은 `inviter.pubkey`를 `keyTrust: "invite"`로 즉시 고정합니다. 초대 코드는 Slack DM으로 1:1 전달되는 대역 외 채널이므로, 이 경로를 신뢰 근거로 삼습니다.

### 4.7 엔드포인트별 신원 요구

| 엔드포인트 | 0.2.2 | 0.2.3 strict (`requireKeys: true` 기본) |
|---|---|---|
| `GET /v1/ping` (공개) | 변화 없습니다 | 변화 없습니다 |
| `GET /v1/ping` (서명) | 응답에 `pubkey`를 추가합니다 | 키 서명을 필수로 요구합니다 |
| `GET /v1/sessions` | HMAC만 있어도 세션 목록을 줍니다. grant와 safety는 고정 키 호출자에게만 줍니다 | 키 서명을 필수로 요구합니다. grant와 safety는 고정 키에만 줍니다(열린 질문 1) |
| `POST /v1/notes` | 발신자는 kid로 정합니다. v1 호출자는 IP로 정하되, `pubkey`가 없는 항목에만 귀속합니다 | kid로만 정합니다 |
| `POST /v1/hello` | v1과 v2를 모두 받습니다 | v2만 받습니다 |
| `/v1/sessions/:id/*` | 고정 키 호출자만 받습니다 | 같습니다 |

0.2.3 서버는 v1 호출자에게 HMAC으로 서명된 401 `upgrade required`를 돌려줍니다. 이 응답은 기존 `authError` 경로(`team/peer.mjs:652`)를 타므로, 구버전 화면에도 사유가 표시됩니다.

### 4.8 hello v2

요청 본문은 다음과 같습니다. `X-AD-Kid`는 `kid(pubkey)`와 같아야 하며, 서명 검증이 곧 소유 증명(proof of possession)이 됩니다.

```json
{ "v": 2, "name": "will", "port": 7331, "instanceId": "<uuid>", "pubkey": "<b64url 43>" }
```

응답 본문은 다음과 같습니다.

```json
{ "ok": true, "pending": true, "name": "neo", "instanceId": "<uuid>", "pubkey": "<b64url 43>" }
```

서버의 판정은 `teamOnHello`(`main.mjs:1604-1620`)를 대체하며, 다음 다섯 경우로 나뉩니다.

- **새 키, 새 팀원**: pending(`kind: "new"`)으로 둡니다. 확인 창에 표시용 지문을 보여 주고, 사용자가 [추가]를 누르면 `keyTrust: "confirmed"`로 고정합니다. 이것이 사용자 확인을 거치는 TOFU입니다.
- **고정 키와 같은 kid, 다른 host**: 진짜 이동이므로 host를 자동 갱신하고 기록만 남깁니다. 위임은 유지합니다. 그래서 v2 피어에는 `classifyMove`의 경합 판정(`team/peer.mjs:748-755`)이 필요 없습니다.
- **같은 instanceId 또는 같은 host인데 다른 키**: pending(`kind: "rekey"`)으로 두고 경고를 표시합니다. 그 팀원의 위임은 즉시 해제합니다(사유 `key changed`). 자동으로 교체하지 않습니다.
- **고정 키가 없는 기존 v1 항목(0.2.1에서 올라온 팀원)**: pending(`kind: "bind"`)으로 두고, "이 팀원의 키를 등록합니다. 지문: …"을 확인받습니다.
- **v1 hello(pubkey 없음)**: 지금과 같이 처리하되, 항목에 `keyTrust`를 남기지 않습니다. 이 팀원은 "신원 미확인"으로 표시됩니다.

### 4.9 비콘

- `encodeBeacon`과 `parseBeacon`(`team/discovery.mjs:14-28`)에 선택 필드 `kid`를 추가합니다. 비콘 버전은 v: 1을 유지합니다. 0.2.1 파서는 추가 필드를 무시합니다(`team/discovery.mjs:24-28`).
- 비콘은 인증되지 않으므로, 여기서 얻은 kid는 `expectKid`로만 저장합니다. 첫 서명 응답이 이 값과 다르면 `key mismatch`로 처리합니다. 지금 instanceId 기대값을 처리하는 방식(`main.mjs:1802-1805`)과 같습니다.

### 4.10 위임과 grant

- 위임 저장소의 키를 `${sessionId}|${instanceId}`에서 `${sessionId}|${kid}`로 바꿉니다(`team/remote.mjs:157-210`). instanceId는 표시용으로만 남깁니다.
- `forInstances(ids)`는 `forKey(kid)`로, `match(sid, grant, ids)`는 `match(sid, grant, kid)`로 바꿉니다.
- 서버의 `caller`(`team/peer.mjs:516`)는 `{ kid, peer }`로 바꾸고, v2 경로에서 ambiguous 개념을 삭제합니다.
- grant는 위임 단위의 폐기 수단이자 심층 방어로 유지합니다. 다만 이제 grant만 탈취해서는 쓸 수 없고, 고정된 키의 서명이 함께 있어야 합니다.
- HTTP 평문이므로 LAN 스니퍼는 grant와 화면 내용을 계속 볼 수 있습니다. 이 점은 7장의 위험 항목에 적었습니다.

### 4.11 team.json 스키마

```json
{
  "name": "neo", "token": "…", "port": 7331, "bind": "0.0.0.0", "instanceId": "<uuid>",
  "identity": { "kid": "<43>", "pub": "<43>" },
  "requireKeys": false,
  "peers": [
    { "name": "will", "host": "10.0.0.5:7331", "instanceId": "<uuid>",
      "pubkey": "<b64url 43>", "keyTrust": "invite", "keyAt": 1760000000000,
      "expectKid": "<43, 비콘에서 얻은 기대값, 선택>" }
  ]
}
```

- `identity`: 표시와 진단용 공개 정보입니다. 진실 원천은 키 파일입니다.
- `requireKeys`: 0.2.2의 기본값은 false이고, 팀이 원하면 일찍 켤 수 있습니다. 0.2.3의 기본값은 true입니다.
- `keyTrust`: `invite` 또는 `confirmed`입니다. 위임은 이 두 값일 때만 허용합니다.

### 4.12 개인키 파일

개인키는 team.json이 아니라 `~/.agentdesk/team-key`(권한 0600, 디렉터리 0700)에 둡니다.

```json
{ "v": 1, "alg": "ed25519", "pub": "<b64url 43>", "enc": "safeStorage", "priv": "<base64(PKCS8 DER, safeStorage면 암호문)>" }
```

`enc`는 `safeStorage` 또는 `plain`입니다.

team.json과 분리하는 이유는 다음과 같습니다.

- team.json은 사용자가 직접 열고 편집하는 파일입니다(`main.mjs:1795`).
- 다른 팀에 합류할 때 앱이 team.json 필드를 다시 씁니다(`main.mjs:1776`).
- 토큰과 개인키가 한 파일에서 함께 유출되는 상황을 피합니다.
- 0.2.1로 다운그레이드해도 키 파일은 그대로 남습니다.

저장 방식은 다음과 같습니다.

- safeStorage를 쓸 수 있으면 사용합니다. 패턴은 `jira-oauth.mjs:25-32`와 같습니다.
- safeStorage를 쓸 수 없는 환경(Linux에 keyring이 없는 경우 등)에서는 `plain` 0600으로 저장하고, 팀 탭에 "키가 암호화되지 않음"을 표시합니다. jira-oauth는 이 경우 저장을 거부하지만(`jira-oauth.mjs:29`), 팀 키에 같은 규칙을 적용하면 팀 기능 전체가 막히므로 대체 저장을 권고합니다.

**중요 규칙**: 키 파일이 있는데 복호화에 실패하면 키를 **절대 자동으로 재생성하지 않습니다**. 신원을 "사용 불가"로 표시하고 v1처럼만 동작합니다. 재생성은 사용자가 확인 창을 거쳐 명시적으로 요청할 때(IPC `team-key-regenerate { confirmed: true }`)만 합니다.

### 4.13 렌더러 비노출 불변식

- 개인키는 `team/identity.mjs`의 클로저 안에만 둡니다. 밖으로는 `{ kid, pub, sign(buf) }`만 내보내고, `JSON.stringify(identity)`가 공개 필드만 출력함을 테스트로 고정합니다.
- 서버에는 `startTeamServer(..., { identity })`로 넘깁니다. `cfg`나 `live` 뷰(`main.mjs:1595`)에는 절대 넣지 않습니다.
- `teamStatus`와 `teamPeerState`에는 kid, 표시용 지문, `keyState` 문자열만 넣습니다. `roca:team-status`가 teamStatus를 펼쳐서 렌더러로 보내기 때문입니다(`main.mjs:1733`). KeyObject가 여기에 들어가면 안 됩니다.
- 토큰은 지금처럼 클립보드로만 나가고(`main.mjs:1759`), grant는 지금처럼 `teamGrants`에만 둡니다(`main.mjs:1490`). 공개키는 비밀이 아니므로 렌더러에 노출해도 됩니다.

---

## 5. 재전송·릴레이·리바인딩 방어 유지 확인

- **재전송**: ts(±120초)와 nonce(250초 메모리)를 Ed25519 입력에 넣으므로 지금처럼 막힙니다. 버킷을 kid로 나누므로, 같은 IP의 다른 팀원이 내 nonce 예산을 소진할 수도 없습니다.
- **릴레이**: host를 서명 입력에 넣는 것에 더해 targetKid도 넣습니다. 그래서 IP가 바뀐 뒤 다른 팀원 PC에 도착한 요청도 거절합니다(`wrong peer`).
- **DNS 리바인딩**: `validHostHeader`와 `isMyHost`(`team/peer.mjs:304-322`, `:468`, `:481`)는 바꾸지 않습니다.
- **응답 위조**: 응답이 서버 kid, 호출자 kid, status까지 서명하므로, 같은 토큰을 가진 다른 팀원도 응답을 위조할 수 없습니다. 지금은 위조가 가능합니다(`team/peer.mjs:259-261`).
- **팀 간 혼동**: teamTag로 막습니다.

---

## 6. 자동 해제 조건 갱신 (`autoRevokeReasons`, `team/remote.mjs:118-140`)

| 사유 | 처리 | 이유 |
|---|---|---|
| `expired` | 유지합니다 | 시간 제한 정책입니다 |
| `teammate removed` | 유지합니다(kid 기준) | |
| `session ended`, `permission checks off/unknown` | 유지합니다 | 신원과 무관한 안전 조건입니다 |
| `ambiguous teammate` (같은 IP) | **삭제합니다** | 키로 구분되므로 같은 IP가 문제되지 않습니다 |
| `identity mismatch` (instanceId) | **`key changed`로 대체합니다** | 고정 키와 다른 kid로 응답하거나 rekey hello를 받은 경우입니다 |
| `teammate moved` (`main.mjs:1817`) | **v2에서는 삭제합니다** | 같은 키로 이동했다면 같은 사람입니다 |
| `local network denied` | **삭제합니다** | 원래 목적이 "신원 재확인 불가"였는데(`team/remote.mjs:115-117`), 이제는 요청마다 키로 확인합니다 |
| `teammate unreachable` (3회, 120초) | 10분 이상 연속 실패일 때만 해제하도록 완화합니다 [설계 선택] | 보안 근거가 사라지고, 생존성 정리 용도만 남습니다 |
| `teammate on another network` | 유지합니다 | 보안상 필수는 아니지만, 사무실 망 정책과 일관되게 유지합니다 |
| `key unverified` (신규) | 추가합니다 | 대상 peer의 `keyTrust`가 사라졌거나(team.json 수동 편집), keyState가 mismatch가 된 경우입니다 |

`canDelegate`(`team/remote.mjs:101-114`)도 다음과 같이 바꿉니다.

- IP 관련 조건 세 가지(`team/remote.mjs:103`, `:106`, `:108`)를 삭제합니다.
- 다음 조건을 추가합니다: `peer.pubkey`가 있어야 하고, `keyTrust`가 `invite` 또는 `confirmed`여야 하며, 마지막 폴링 응답이 그 키로 검증되었어야 합니다(`state.keyOk`).
- 결과적으로 **0.2.2부터 키 없는 피어에는 위임할 수 없습니다**. 이 조건 덕분에 IP 기반 위임 경로가 0.2.2에서 바로 사라집니다.

---

## 7. 전환 단계

### 0.2.2: 키 인식 단계

- 첫 실행 시 키를 생성합니다.
- 모든 요청과 응답에 HMAC 서명과 키 서명을 함께 붙입니다.
- 초대 코드(v1 접두사에 pubkey 추가), hello v2, 비콘 kid로 키를 교환합니다. 처음 등록할 때는 지문을 보여 주고 사용자 확인(TOFU)을 받습니다.
- 위임, grant, safety, 원격 요청은 고정 키 호출자만 받습니다.
- v1 피어는 세션 보기와 메모(키 없는 항목에만 IP로 귀속)만 할 수 있고, "신원 미확인(구버전)" 배지가 붙습니다. 위임은 할 수 없습니다.
- `requireKeys`는 선택 사항입니다.

### 0.2.3: 키 필수 단계

- `requireKeys: true`가 기본값이 됩니다. v1 요청은 401 `upgrade required`를 받습니다.
- 초대 코드 접두사를 v2로 바꿉니다.
- 다음 코드를 삭제합니다: `classifyMove`, ambiguous 판정, 메모의 IP 귀속, instanceId 기반 mismatch, 위임 대상의 1분 전체 조회(`main.mjs:1646-1651`). 304 응답도 키로 서명되므로 전체 조회가 더 이상 필요하지 않습니다.

### 0.2.4 이후 (선택)

- 신원 확인이 키로만 이루어지게 되면, 대안 B(토큰 제거와 서명된 명부)나 기밀성 추가(X25519 기반 AEAD 또는 고정 키 TLS)를 검토합니다.

---

## 8. 변경 파일 표

| 파일 | 바뀌는 함수·항목 | 예상 크기 |
|---|---|---|
| `team/identity.mjs` (신규) | `loadOrCreateIdentity({ file, safeStorage })`, `kidOf(pub)`, `displayFp(pub)`, `teamTag(token)`, `reqKeyInput()`, `resKeyInput()`, `signKey()`, `verifyKey(pub, input, sig)`, `importPub(b64url)` (캐시 포함) | 약 160줄 |
| `team/peer.mjs` | `readTeamConfig`(peers의 pubkey, keyTrust, keyAt, expectKid와 requireKeys, identity 유지), `upsertPeer`와 `addPeerToConfig`(키 필드와 rekey 판정), `encodeInvite`와 `decodeInvite`(v: 2, pubkey, 0.2.3 접두사), `signRequest`와 `verifyRequest`(키 레이어, kid 버킷), `createNonceGuard`(버킷 키 이름 일반화), `startTeamServer`(caller를 kid로, 메모 발신자, hello v2, ping 응답의 pubkey, 응답 키 서명), `signedFetch`(고정 공개키 검증, 다운그레이드 금지), `fetchPeer`, `postNote`, `postHello`, `remote*`, `pingPeerSigned`(identity와 고정 공개키 인자), `classifyMove`(v1 전용으로 표시하고 0.2.3에서 삭제) | 약 +170 / −20줄 |
| `team/remote.mjs` | `createDelegationStore`(kid 키, `forKey`, `match`), `canDelegate`, `autoRevokeReasons`, 머리 주석 | 약 +40 / −25줄 |
| `team/discovery.mjs` | `encodeBeacon`, `parseBeacon`에 선택 필드 kid 추가 | 약 +6줄 |
| `main.mjs` (팀 블록 약 1446-1922행) | `teamReload`(identity 1회 로드, 실패 상태 표시), `teamOnHello`(new, move, rekey, bind), `teamSayHello`(pubkey 전송), `teamPoll`(keyOk와 keyMismatch, 1분 전체 조회는 0.2.3에서 삭제), `teamAutoRevoke`, `team-invite-create`와 `team-invite-join`(키 고정), `team-add-peer`(expectKid), `team-hello-decide`(키 고정, rekey), `team-delegate`와 `teamGrantFor`(kid), `team-note-send`(port 힌트는 0.2.3에서 삭제). 신규 IPC: `team-key-info`, `team-peer-confirm-key`, `team-key-regenerate` | 약 +130 / −30줄 |
| `preload.cjs` | 신규 IPC 3개(`preload.cjs:40-69` 근처) | +3줄 |
| `widget.html` (팀 탭 UI) [추정: 팀 UI가 이 파일에 있다고 보았지만 읽지 않았습니다] | 지문 표시, "신원 미확인" 배지, rekey 경고, 내 지문 복사 | 약 +80줄 |
| `docs/TEAM-GUIDE.md` | `:63`(서명 설명에 키 레이어 추가), `:92` 문제 해결 표(`key changed`, `unknown key`, `신원 미확인(구버전)`, `upgrade required`, `지문 확인 필요` 추가), `:106`(같은 키의 이동은 자동 반영), `:125`(위임 조건), `:142`(자동 해제 목록), `:146-148`(IP 한계를 삭제하고, 남는 한계로 평문 전송 명시), `:173-190`(스키마 표), 지문 대조 방법 절 신규 | 약 +60 / −15줄 |

### 새 테스트 목록

새 파일 `test/team-identity.test.mjs`를 만들고 기존 테스트 파일을 확장합니다. 합계는 약 450줄로 추정합니다.

1. 키 생성, 저장, 로드: 권한 0600, safeStorage 주입과 대체 저장, 복호화 실패 시 재생성하지 않음, `JSON.stringify(identity)`에 개인키가 없음.
2. 서명 입력 고정 벡터: 고정된 키, ts, nonce로 known-answer를 확인합니다.
3. 요청 검증: 형식 오류, skew, HMAC 실패, 미등록 kid, `X-AD-To` 불일치, 본문·path·host 변조, nonce 재사용, kid 버킷 분리.
4. 응답 검증: 서버 kid 불일치, status 변조, 고정 peer의 키 서명이 빠진 응답을 다운그레이드로 거절.
5. v2 클라이언트와 v1 서버: HMAC만 쓰는 서버를 흉내 내고, 세션은 보이지만 "신원 미확인"으로 표시되며 위임이 불가함을 확인합니다.
6. v1 클라이언트와 v2 서버: 세션 목록은 받지만 grant와 safety는 없음, 메모는 키 없는 항목에만 IP로 귀속, 키가 있는 항목의 IP에서 온 v1 메모는 403.
7. 같은 IP의 두 팀원(v2): 각자 자기 grant만 받고 ambiguous가 되지 않음. 기존 `test/team-remote.test.mjs:168`과 `test/team-safety.test.mjs:130`은 v1 전용으로 범위를 좁힙니다.
8. IP 탈취 시나리오: 토큰을 가진 C가 B의 IP로 요청해도 kid가 다르면 grant 0개, 원격 요청은 403.
9. hello v2: 소유 증명 실패(헤더 kid와 본문 pubkey의 kid가 다름)는 401, new·move·rekey·bind 분기, rekey는 위임을 해제.
10. 초대 코드: v1 접두사에 pubkey를 넣은 코드를 0.2.1 디코더로도 해석할 수 있음(`test/team-setup.test.mjs:14` 확장), 0.2.3 모드에서 pubkey가 없으면 거절.
11. `readTeamConfig`와 `upsertPeer`가 키 필드를 보존함.
12. `canDelegate`와 `autoRevokeReasons` 표 기반 테스트: `test/team-remote.test.mjs:221`, `:245`를 대체합니다.
13. `requireKeys: true`: v1 요청은 서명된 401 `upgrade required`를 받음.
14. 비콘 kid 필드: 형식이 틀리면 버리고, 0.2.1 파서는 무시함.

---

## 9. 권고 순서

1. **`team/identity.mjs`와 peer.mjs의 서명 레이어를 먼저 구현합니다.** 노력은 중간이고 효과는 가장 큽니다. 나머지 모든 변경의 기반이기 때문입니다.
2. **위임 경로를 kid로 전환합니다.** 위임 저장소, 서버의 caller, `canDelegate`, `autoRevokeReasons`가 대상입니다. 노력은 중간이고 효과는 큽니다. 가이드의 "알려진 한계"(`docs/TEAM-GUIDE.md:148`)를 해소합니다.
3. **키 교환 UX를 만듭니다.** 초대 코드, hello v2, 확인 창의 지문, rekey 경고가 대상입니다. 노력은 중간이고 효과는 큽니다. 이 단계가 없으면 키가 있어도 신뢰의 근거가 생기지 않습니다.
4. **0.2.3에서 IP 경로를 삭제합니다.** 노력은 낮고 효과는 중간입니다. 코드가 단순해집니다.

---

## 10. 트레이드오프

| 선택지 | 장점 | 단점 |
|---|---|---|
| A. HMAC 유지와 Ed25519 추가 (권고) | 0.2.1과 와이어 호환입니다. 토큰 없는 공격자를 0.9 µs HMAC으로 먼저 거릅니다. 단계적으로 전환할 수 있습니다. strict 모드에서는 팀원 삭제가 곧 축출입니다 | 비밀이 두 종류라서 개념이 복잡합니다. 0.2.2에서는 초대 코드가 유출되면 세션 목록을 여전히 볼 수 있습니다 |
| B. 토큰 제거와 키 명부 | 공유 비밀이 없어 초대 코드 유출을 무해하게 만들 수 있습니다. 팀원별 폐기가 자연스럽습니다 | 명부 배포(n² 확인 또는 초대자 서명 명부)를 새로 만들어야 합니다. 0.2.1과 즉시 단절됩니다. 비인가 요청에도 Ed25519 검증 비용이 듭니다 |
| 키 저장: safeStorage | OS 키체인으로 보호합니다 | [추정] 앱 서명이 바뀌면 복호화에 실패할 수 있고, 그러면 "키 변경" 사태가 생깁니다 |
| 키 저장: 평문 0600 | 단순하고 이식성이 좋습니다 | 디스크를 읽을 수 있으면 키가 유출됩니다. 다만 team.json의 토큰도 지금 같은 수준입니다 |

### 반대 논거와 긴장

- **반대 논거(steelman)**: 사무실 LAN에서 토큰을 가진 내부자가 ARP 스푸핑까지 하는 위협은 드뭅니다. 위임은 이미 2시간으로 제한되고 1분마다 재확인됩니다. 따라서 키 관리 UX(지문 확인, rekey, PC 교체)의 비용이 보안 이득보다 클 수 있습니다.
- **반론**: 위임은 원격 입력, 곧 코드 실행 권한입니다. 1분의 틈과 IP 기반 귀속은 이 권한에 걸맞지 않습니다. 0.2.2에서는 위임 경로에만 키를 필수로 요구하고 나머지는 호환을 유지하므로, UX 비용은 위임을 쓰는 팀원에게만 생깁니다.
- **트레이드오프 긴장**: strict 열람 정책(고정 키만 세션 목록 열람)은 축출을 확실하게 하지만, 합류 직후 상호 [추가] 전까지 목록이 보이지 않는 UX 후퇴를 낳습니다(열린 질문 1).

---

## 11. 위험과 열린 질문

1. **0.2.3 strict에서 `/v1/sessions` 열람 범위**: "아무 키든 서명만 있으면 열람"과 "고정된 키만 열람" 중에서 골라야 합니다. 후자를 고르면, 초대자가 아직 [추가]를 누르지 않은 상태에서 합류자의 첫 조회(`main.mjs:1787`)가 실패합니다. 권고는 열람은 아무 키나 허용하고, 메모·grant·safety는 고정 키만 허용하는 것입니다. 결정이 필요합니다.
2. **macOS safeStorage와 앱 재서명**: [추정] 사내 빌드의 코드 서명이 업데이트마다 바뀌면, 키체인 항목에 접근할 때 확인 창이 뜨거나 복호화에 실패할 수 있습니다. 이를 뒷받침할 증거가 아직 없으므로, 0.2.2 사내 빌드 두 개로 업데이트 시나리오를 실측해야 합니다. 실패 시 재생성하지 않는 규칙은 필수입니다.
3. **기밀성 없음**: Ed25519는 인증만 제공합니다. grant, 화면, 마지막 응답은 여전히 HTTP 평문으로 전송됩니다. 다만 키 서명이 필요하므로, grant를 엿보아도 사용할 수는 없습니다. 가이드에 남는 한계로 명시해야 합니다.
4. **PC 교체와 재설치**: 새 키가 생기면 팀원 전원에게 rekey 확인이 필요합니다. 키 백업·내보내기를 제공할지 정해야 합니다. 권고는 제공하지 않고 키를 PC에 묶는 것입니다.
5. **TOFU의 강도**: 사용자가 hello 확인 창의 지문을 실제로 대조하지 않으면, TOFU는 첫 연결 시점의 공격에 약합니다. 보강안은 초대 코드에 일회용 join ticket(16바이트)을 넣고, hello에 `HMAC(ticket, pubkey)`를 담는 것입니다. 그러면 초대자 쪽 확인 창에 "초대 코드로 합류함(확인됨)"을 표시할 수 있습니다. 이 보강안을 0.2.2 범위에 넣을지 정해야 합니다.
6. **instanceId의 역할**: 0.2.3 이후 instanceId는 표시와 이동 감지 보조로만 쓰입니다. 완전히 제거할지는 비콘 중복 제거 로직(`main.mjs:1724-1728`)과 함께 결정해야 합니다.
7. **검증하지 않은 항목**:
   - 팀 탭 UI 파일(`widget.html`)과 `core/team.js` 본문은 읽지 않았습니다. 따라서 UI 변경 크기는 [추정]입니다.
   - Ed25519 동작은 이 PC의 Node 26.9와 설치된 AgentDesk.app(Electron 36.9.5)에서만 확인했습니다. Windows와 Linux 빌드에서는 실측하지 않았습니다.

### 확인한 범위와 확인하지 않은 범위

- **확인함**: `team/peer.mjs` 전체, `team/remote.mjs` 전체, `team/discovery.mjs` 전체, `team/setup.mjs` 전체, `main.mjs` 1440-1929행, `preload.cjs`의 팀 API, `jira-oauth.mjs`의 safeStorage 사용, `docs/TEAM-GUIDE.md`의 관련 절, 테스트 목록, Electron 36.9.5와 Node 26.9에서의 Ed25519 실측.
- **확인하지 않음**: `widget.html`, `core/team.js` 본문, `team/localnet.mjs` 본문, Windows와 Linux 런타임.

---

## 12. 참조

- `team/peer.mjs:256-303`: 현재 HMAC 서명 입력, 검증 순서, IP 버킷 nonce guard입니다.
- `team/peer.mjs:489-517`: hello의 IP 기반 host, 메모 발신자의 IP 귀속, 원격 호출자 판정(ambiguous)입니다.
- `team/peer.mjs:525-527`, `:554-556`: grant 배포와 사용이 IP의 instanceId에 묶인 지점입니다.
- `team/peer.mjs:641-649`: 클라이언트의 응답 검증으로, 토큰만 사용합니다.
- `team/peer.mjs:160-174`: 초대 코드 v1입니다. 모르는 필드를 무시하므로 0.2.2에서 접두사를 유지할 수 있습니다.
- `team/peer.mjs:81`, `:105-111`, `:128`: peers 정규화가 필드를 버리는 지점과, raw 객체를 보존하는 경로입니다.
- `team/peer.mjs:748-755`: `classifyMove` 경합 판정입니다.
- `team/remote.mjs:101-140`: `canDelegate`와 `autoRevokeReasons`의 IP 조건입니다.
- `team/remote.mjs:157-210`: instanceId를 키로 쓰는 위임 저장소입니다.
- `team/discovery.mjs:14-28`: 비콘 형식과 파서이며, 추가 필드를 무시합니다.
- `main.mjs:1595-1596`: 서버에 넘기는 live 뷰입니다. 개인키를 넣으면 안 되는 자리입니다.
- `main.mjs:1604-1633`: `teamOnHello`와 `teamSayHello`입니다.
- `main.mjs:1646-1661`: 1분 전체 조회와 instanceId mismatch 처리입니다.
- `main.mjs:1733`, `:1749-1794`, `:1811-1822`, `:1862-1922`: 상태 IPC, 초대와 합류, hello 결정, 위임과 원격 IPC입니다.
- `jira-oauth.mjs:25-32`: safeStorage 저장 패턴입니다.
- `preload.cjs:40-69`: 렌더러에 노출되는 팀 API 목록입니다.
- `docs/TEAM-GUIDE.md:63`, `:92`, `:106`, `:142`, `:146-148`, `:173-190`: 가이드에서 고칠 위치입니다.
- `test/team.test.mjs:73`, `:137`, `:188`, `test/team-remote.test.mjs:168`, `:221`, `:245`, `test/team-safety.test.mjs:130`, `test/team-setup.test.mjs:14`, `:68`: 확장하거나 범위를 좁힐 기존 테스트입니다.

---

## 13. 결정 (2026-10-21, 구현 전)

- 열린 질문 1: `/v1/sessions` 열람은 **서명된 키라면 누구나**(HMAC + 유효한 키 서명) 허용한다. grant·safety·메모 귀속·원격 요청은 **고정(pinned) 키만**.
- 열린 질문 5: 초대 코드에 일회용 **join ticket(16바이트)** 를 넣고, 합류자의 hello v2에 `HMAC-SHA256(ticket, pubkey)` 를 담는다. 초대자는 티켓이 맞으면 "초대 코드로 합류함(확인됨)"으로 표시하고 `keyTrust: "invite"` 로 자동 고정한다(사용자 확인 창은 그대로 띄우되 기본 선택이 [추가]). 티켓은 1회용·24시간.
- 열린 질문 4: 키 백업·내보내기는 제공하지 않는다. PC 교체 시 rekey 흐름을 쓴다.
- 0.2.2 에서 `requireKeys` 기본값은 false. 0.2.3 에서 true.
- 2단계 구현 제약(보안 검토 L4, 2026-10-21):
  - `onHello`의 `ticketOk: true`만으로 bind·rekey를 자동 적용하지 않는다. 티켓은 "초대 코드로 합류함(확인됨)" 표시와 새 팀원(`kind: "new"`)의 `keyTrust: "invite"` 근거로만 쓰고, bind·rekey는 항상 사용자 확인 창을 거친다.
  - 응답(`fetchPeer`·`pingPeerSigned`·`postHello`)이 돌려준 `pubkey`·`kid`를 team.json에 자동으로 고정하지 않는다. 미고정 키는 지문 확인 창에서 사용자가 [추가]를 누를 때만 `keyTrust: "confirmed"`로 고정한다.
  - 미고정 키는 `/v1/ping`·`/v1/sessions`·`/v1/hello`에서만 받는다(그 밖은 401 `unknown key`). nonce 한도는 고정 키만 kid별로, 미고정 키는 IP 버킷을 함께 쓴다(보안 검토 M1).
