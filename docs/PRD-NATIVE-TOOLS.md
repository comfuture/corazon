# PRD: App-Server 네이티브 동적 툴 도입 (`manage-workflows`, `shared-memory`)

## 배경 / 문제 정의
현재 `manage-workflows`, `shared-memory`는 skill 지시 + Python 스크립트 호출 경로를 통해 동작한다. 이 경로는 유연하지만 다음 비용이 있다.
- 스킬 선택/지시 해석 오버헤드
- 프로세스 실행(Python/uvx) 오버헤드
- app-server 동적 툴 이벤트와의 직접 연계 부족

app-server JSON-RPC 경로에서는 동적 툴을 thread 시작 시 주입할 수 있으므로, 두 기능을 네이티브 툴로 내장하면 응답성과 제어 가능성이 올라간다.

## 목표
- app-server 모드에서 `corazon/manageWorkflow`, `corazon/sharedMemory`를 네이티브 dynamic tool로 제공한다.
- `item/tool/call` 요청을 프로토콜 레벨에서 직접 처리한다.
- 기존 Python 스크립트의 주요 커맨드/입출력 계약을 유지한다.
- 프론트엔드에서 이미 처리 가능한 `dynamicToolCall` 이벤트 흐름을 그대로 활용한다.

## 비목표
- SDK 모드에서 동적 툴 동일 동작 강제
- 기존 skill 템플릿/스크립트 제거
- 워크플로우/메모리 도메인 로직의 전면 재설계

## 요구사항
1. 동적 툴 주입
- `thread/start` 시 `dynamicTools`에 네이티브 툴 스펙 주입
- `thread/resume` 경로는 현재 app-server API 제약을 따르고, 신규 thread 생성 경로에서 보장

2. 툴 실행
- `item/tool/call` 수신 시 툴 이름 매칭 후 로컬 함수 실행
- 표준 응답: `contentItems[]`, `success`
- 오류 시 명시적 실패 응답 반환

3. `corazon/sharedMemory` 네이티브 커맨드
- `ensure`, `search`, `upsert`
- 기존 스크립트와 유사한 JSON payload (`ok`, `error`, 결과 필드)

4. `corazon/manageWorkflow` 네이티브 커맨드
- `list`, `create`, `update`, `delete`, `from-text`, `apply-text`
- Python 스크립트의 deterministic parsing 규칙을 TypeScript 함수로 이식

5. 메인 루프 지시문 정합화
- app-server 모드에서는 skill 대신 네이티브 툴을 우선 사용하도록 라우팅 힌트 보강
- sdk 모드와의 호환성은 유지

## 아키텍처 제안
- `server/utils/codex-client/native-tools.ts`
  - 툴 스펙 정의 (`DynamicToolSpec`)
  - 인자 검증/정규화
  - `corazon/sharedMemory`, `corazon/manageWorkflow` 핸들러
- `server/utils/codex-client/app-server-protocol.ts`
  - 생성자에서 네이티브 툴 레지스트리 주입
  - `item/tool/call` dispatch
- `server/utils/codex-client/app-server-client.ts`
  - `thread/start`에 `dynamicTools` 전달
- `server/utils/chat-turn.ts` / `server/utils/agent-bootstrap.ts`
  - app-server 모드 우선 라우팅 문구 보완

## 리스크
- LLM이 기존 skill 이름을 계속 우선 선택할 수 있음
- `from-text`/`apply-text` 추론 규칙 이식 누락 시 행동 차이 발생
- dynamic tool schema 과도 확장 시 모델 호출 정확도 저하

## 완화 전략
- tool 이름을 기존 skill 명칭과 최대한 정합(`manage-workflows`, `shared-memory`)
- 파이썬 스크립트 핵심 규칙(트리거 추론/액션 분기)을 그대로 이식
- 인자 스키마를 단순화하고, 서버에서 엄격 검증 + 오류 메시지 명시

## 완료 기준
1. app-server 모드 신규 thread에서 두 네이티브 툴이 `dynamicTools`로 주입된다.
2. `item/tool/call`로 두 툴 호출 시 성공/실패 응답이 정상 반환된다.
3. 워크플로우/메모리 관련 요청이 스킬 스크립트 실행 없이 처리된다.
4. `pnpm lint`, `pnpm typecheck` 통과 (`pnpm check` 스크립트 부재 시 명시).

## 구현 체크리스트

### Phase 0: 문서화
- [x] `docs/PRD-NATIVE-TOOLS.md` 작성
- [x] 구현 단계/커밋 단위 확정

### Phase 1: 네이티브 툴 모듈
- [x] `native-tools.ts` 추가
- [x] `corazon/sharedMemory` 커맨드(`ensure/search/upsert`) 구현
- [x] `corazon/manageWorkflow` 커맨드(`list/create/update/delete/from-text/apply-text`) 구현
- [x] 동적 툴 입력 스키마 정의

### Phase 2: app-server 하네스 연결
- [x] `app-server-protocol.ts`에 dynamic tool dispatcher 연결
- [x] `thread/start`에 `dynamicTools` 전달
- [x] 미지원 툴/입력 오류 처리 통일

### Phase 3: 메인 루프 정합화
- [x] app-server 모드 라우팅 힌트 보강 (`chat-turn.ts`)
- [x] shared-memory 안내 문구 보강 (`agent-bootstrap.ts`)

### Phase 4: 검증/마무리
- [x] `pnpm lint`
- [x] `pnpm check` 실행 시도 및 결과 기록
- [x] `pnpm typecheck`
- [x] 단계별 atomic 커밋 완료

검증 메모:
- `pnpm check`는 현재 `package.json`에 스크립트가 없어 `Command "check" not found`로 종료됨(의도된 상태 확인).

적용 커밋:
1. `docs: add native dynamic tools PRD and checklist`
2. `feat: add native app-server dynamic tools for memory and workflows`
3. `refactor: prioritize native app-server tools in routing guidance`
4. `fix: use explicit agent-home extension in workflow definitions`
5. `fix: support rrule default export in workflow utils`
