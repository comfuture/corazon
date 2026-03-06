# PRD: Telegram Transport

## 배경 / 문제 정의
Corazon은 현재 웹 UI 중심의 채팅 경험만 제공한다. 사용자가 텔레그램 대화방에서도 동일한 `chat-turn` 워크플로우를 통해 Corazon과 대화하고, 필요 시 웹 UI에서 동일 스레드를 이어볼 수 있는 transport 계층이 필요하다.

텔레그램은 웹처럼 세밀한 스트리밍 UI를 제공하기 어렵고, 이미 전송된 메시지 수정 비용도 상대적으로 크다. 따라서 웹 채널과 같은 내부 실행 파이프라인을 재사용하되, 텔레그램 채널 특성에 맞는 입력/출력/스레드 분리 규칙을 별도로 설계해야 한다.

## 목표
- 텔레그램 봇 long polling으로 하나의 설정된 `chat_id`를 수신한다.
- 텔레그램 입력을 기존 `chat-turn` 워크플로우와 동일하게 처리한다.
- 텔레그램에서 시작된 스레드만 텔레그램으로 응답을 보낸다.
- 웹 UI에서 텔레그램-origin 스레드를 조회/이어받을 수 있다.
- 텔레그램 idle timeout 이후에는 새 Corazon thread로 분리하되, compact carry-over summary를 숨은 프리픽스로 이어 붙인다.

## 비목표
- 다중 텔레그램 대화방/다중 봇 동시 지원
- webhook 수신 모드
- 텔레그램 비텍스트 입력(사진, 파일, 음성)의 v1 처리
- 웹에서 시작된 turn을 텔레그램으로 미러링
- 텔레그램 UI와 웹 UI의 렌더링 규약 일치

## 설정 / API 계약

### `config.toml`
```toml
[telegram]
bot_token = "123456:ABC..."
chat_id = "-1001234567890"
idle_timeout_minutes = 15
```

규칙:
- `bot_token`, `chat_id`가 모두 있어야 transport 활성화
- `idle_timeout_minutes` 기본값은 `15`
- `idle_timeout_minutes`는 정수 분 단위이며 최소 `1`

### Settings API
- `GET /api/settings/telegram`
  - 응답: `{ telegram: { botToken, chatId, idleTimeoutMinutes, enabled } }`
- `PUT /api/settings/telegram`
  - 요청: `{ telegram: { botToken, chatId, idleTimeoutMinutes } }`
  - 응답: `GET`과 동일

### Settings UI
- `/settings/telegram`
- 입력 필드:
  - Bot token
  - Chat ID
  - Idle timeout (minutes)
- 보조 정보:
  - 설정 파일 경로
  - 활성화 조건 안내
  - long polling 동작 안내

## 내부 인터페이스 변경
- `types/chat-ui.ts`
  - `CodexChatWorkflowInput`에 `inputPrefix?: string | null` 추가
- `server/utils/chat-turn.ts`
  - 실제 Codex 입력 생성 시 `inputPrefix`가 있으면 마지막 사용자 입력 앞에 프롬프트 힌트처럼 prepend
  - 저장되는 `messages` 자체는 변경하지 않음
- `server/api/chat/control.post.ts`
  - steering 유효성 검사/입력 변환 로직을 공용 유틸로 분리
- 신규 공용 유틸:
  - Telegram과 웹이 동일한 steering 검증/입력 변환 로직을 공유

## 데이터 모델

### `threads` 테이블 확장
- `origin TEXT NULL`
  - 값: `telegram` | `web` | `NULL`
- `origin_channel_id TEXT NULL`
  - 텔레그램 chat id 저장

규칙:
- 텔레그램-origin 스레드 생성 시 `origin='telegram'`, `origin_channel_id=<chat_id>`
- 웹 경로에서는 기존 스레드가 아니면 `origin='web'`
- 기존 데이터는 `NULL` 허용

### `telegram_transport_state`
- `key TEXT PRIMARY KEY`
- `last_update_id INTEGER`
- `last_poll_started_at INTEGER`
- `last_poll_succeeded_at INTEGER`
- `last_poll_error TEXT`
- `updated_at INTEGER NOT NULL`

용도:
- long polling offset 복구
- 폴링 오류 관찰

### `telegram_sessions`
- `id TEXT PRIMARY KEY`
- `chat_id TEXT NOT NULL`
- `thread_id TEXT`
- `active_run_id TEXT`
- `last_inbound_message_id INTEGER`
- `last_outbound_message_id INTEGER`
- `last_outbound_kind TEXT`
- `started_at INTEGER NOT NULL`
- `last_inbound_at INTEGER NOT NULL`
- `last_completed_at INTEGER`
- `carryover_summary TEXT`
- `status TEXT NOT NULL DEFAULT 'active'`
- `last_error TEXT`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

인덱스:
- `(chat_id, updated_at DESC)`
- `(thread_id)`

규칙:
- configured `chat_id`당 최신 세션 1개를 active candidate로 본다
- `active_run_id`는 텔레그램이 시작한 run만 저장
- consecutive non-text 출력 edit 병합을 위해 직전 outbound bot message id/kind 보관

## 텔레그램 입력 규칙
- long polling만 사용
- `getUpdates` offset은 DB 상태에서 복구
- 허용 입력:
  - `message.text`
- 무시:
  - `edited_message`
  - bot/self message
  - 다른 `chat_id`
- 비텍스트 입력:
  - 짧은 안내 문구를 텔레그램에 답장
  - `chat-turn`에 전달하지 않음
- group chat 발화자 표기:
  - 가능하면 `"<display name>: <text>"` 형식으로 전달

## 세션 결정 / 스레드 분리 규칙
- 현재 `chat_id`의 최신 `telegram_session` 조회
- 다음 중 하나면 기존 세션 재사용:
  - `active_run_id`가 있고 해당 run이 아직 진행 중
  - `last_completed_at`가 있고 현재 시각과 차이가 `idle_timeout_minutes` 이하
- 그 외에는 새 세션 생성

새 세션 생성 규칙:
1. 이전 세션의 `thread_id`가 있으면 저장된 Corazon 메시지를 읽는다.
2. 저비용 Codex helper turn으로 compact carry-over summary를 생성한다.
3. 새 `telegram_session`에 summary를 저장한다.
4. 첫 Telegram 입력 처리 시 `CodexChatWorkflowInput.inputPrefix`로 prepend 한다.
5. `thread.started` 시점에 새 Corazon `thread_id`를 세션에 연결한다.

carry-over summary 제약:
- 10줄 이하
- 열린 TODO, 사용자 의도, 작업 컨텍스트, 최근 결정만 유지
- 원문 전체 인용 금지

## 텔레그램 출력 규칙
- 텔레그램-origin turn은 workflow run을 서버 측에서 직접 시작하고 stream을 소비한다.
- 텍스트:
  - `text-end`에서만 전송
  - delta 단위 편집 금지
- non-text item:
  - `item.completed`에서만 전송/갱신
  - 1~2줄 모바일 친화 요약으로 축약
  - 원시 JSON / 전체 tool output / 전체 command output 금지
- 연속 non-text item:
  - 직전 outbound가 non-text면 새 메시지 대신 기존 bot message를 edit
  - assistant text가 끼면 병합 상태 초기화
- 모든 outbound는 triggering Telegram user message에 reply

### non-text 포매팅 가이드
- `command_execution`
  - `Command: <command>`
  - `Result: completed|failed`
- `mcp_tool_call`
  - `Tool: <server>/<tool>`
  - `Result: completed|failed`
- `file_change`
  - `Files changed: <count>`
  - 필요 시 최대 3개 path만 표시
- `web_search`
  - `Web search: <query>`
- `todo_list`
  - `Todo updated: <completed>/<total>`
- `error`
  - `Error: <message>`

## 채널 분리 규칙
- Telegram-origin turn만 Telegram으로 출력
- 웹-origin turn은 같은 `thread_id`라도 Telegram으로 출력하지 않음
- Telegram 입력이 들어왔는데 스레드의 active run이 web-origin이면 steering하지 않고 busy 안내 후 종료

## 구현 체크리스트

### Phase 0: 문서화 / 브랜치
- [x] 브랜치 생성: `feat/telegram-transport`
- [x] `docs/PRD-TELEGRAM-TRANSPORT.md` 작성

### Phase 1: 설정 / UI
- [ ] `types/settings.ts` 텔레그램 타입 추가
- [ ] `server/utils/settings-config.ts` 텔레그램 read/write 추가
- [ ] `GET/PUT /api/settings/telegram` 구현
- [ ] `/settings/telegram` 페이지 구현
- [ ] settings sidebar/navigation 확장
- [ ] settings root redirect를 텔레그램 탭으로 유지할지 검토 후 현행 유지

### Phase 2: DB / 세션 라우팅
- [ ] `threads` origin 컬럼 추가
- [ ] `telegram_transport_state` 테이블 추가
- [ ] `telegram_sessions` 테이블 추가
- [ ] DB CRUD 유틸 추가
- [ ] 텔레그램-origin thread 판별 유틸 추가

### Phase 3: Telegram ingress
- [ ] Telegram Bot API 클라이언트 유틸 추가
- [ ] long polling Nitro plugin 추가
- [ ] poll offset 저장/복구
- [ ] configured `chat_id` 필터링
- [ ] 비텍스트 입력 short reply 처리
- [ ] 텔레그램 세션 선택/생성 로직 연결

### Phase 4: Workflow bridge
- [ ] 텔레그램 입력으로 `chat-turn` workflow 실행
- [ ] `thread.started` 시 세션에 thread 바인딩
- [ ] `turn.completed`/실패 시 세션 run 상태 정리
- [ ] 텍스트 완료 단위 전송
- [ ] non-text 완료 단위 축약 포맷 전송
- [ ] consecutive non-text edit 병합

### Phase 5: Steering / Carry-over
- [ ] steering 검증/입력 변환 공용화
- [ ] active Telegram run steer 처리
- [ ] web-origin active run busy 방지
- [ ] idle timeout rollover 구현
- [ ] compact carry-over summary 생성 및 `inputPrefix` 주입

### Phase 6: 검증 / 마무리
- [ ] 수동 검증: 설정 저장
- [ ] 수동 검증: 첫 Telegram 메시지 -> thread 생성
- [ ] 수동 검증: timeout 이내 재사용
- [ ] 수동 검증: timeout 이후 rollover
- [ ] 수동 검증: Telegram steer
- [ ] 수동 검증: web turn 미미러링
- [ ] 수동 검증: unsupported non-text 처리
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] 단계별 atomic commit 완료

## 리스크 / 대응
- Telegram polling 중복 실행
  - Nitro plugin singleton guard + DB offset 저장으로 완화
- 텔레그램 메시지 edit 남발
  - non-text consecutive case에만 edit 허용
- carry-over summary 품질 저하
  - 저비용 helper prompt를 고정하고 최대 길이 제한
- web/telegram active run 경쟁
  - run ownership을 session 기준으로 명시 저장

## 완료 기준
1. 텔레그램 설정 저장 후 서버 재시작 없이 polling이 새 설정을 반영한다.
2. 텔레그램 첫 입력이 새 Corazon thread를 생성하고 웹 UI에서 조회된다.
3. idle timeout 내 메시지는 동일 thread로 이어진다.
4. idle timeout 후 메시지는 새 thread로 분리되며 흐름 continuity가 유지된다.
5. 텔레그램-origin turn만 텔레그램으로 출력된다.
6. 텔레그램 non-text 출력은 compact format으로 표시되고 연속 item은 edit 병합된다.
7. `pnpm typecheck`, `pnpm lint` 통과.

## 적용 커밋 계획
1. `docs: add telegram transport PRD and checklist`
2. `feat: add telegram settings schema api and nuxt ui screen`
3. `feat: persist telegram polling state and telegram session routing`
4. `feat: bridge telegram long polling to chat-turn workflow`
5. `feat: add telegram steer handling carryover summaries and compact output formatting`
