# PRD: Codex App Server Harness 도입 및 듀얼 모드 전환

## 배경 / 문제 정의
현재 Corazon은 `@openai/codex-sdk`에 직접 의존해 Codex turn을 수행한다. 이 방식은 단순하고 안정적이지만, app-server 기반의 양방향 JSON-RPC 기능(예: dynamic tool call, request/response 제어) 확장성이 제한된다.

## 목표
- app-server 하네스를 `server/utils`에 별도 모듈로 구축한다.
- `sdk` 또는 `app-server` 모드를 런타임에서 선택할 수 있게 한다.
- 기존 채팅/워크플로우 기능과 UI 파트 규약(`data-codex-event`, `data-codex-item`)을 유지한다.
- 장기적으로 기본 동작을 app-server 경로로 전환 가능한 기반을 마련한다.

## 비목표
- 메시지 UI 구조/디자인 리뉴얼
- DB 스키마 대수술
- MCP/skills 설정 UI 자체의 재설계

## 요구사항
1. 의존성:
   - `@openai/codex-sdk`를 최신 안정 버전으로 업데이트한다.
2. 타입:
   - `codex app-server generate-ts --experimental` 기반 타입 산출물을 프로젝트에 관리 가능한 형태로 도입한다.
3. 아키텍처:
   - 공통 인터페이스(클라이언트/스레드/런)로 SDK/app-server 구현을 교체 가능하게 만든다.
   - app-server 구현은 stdio JSON-RPC 하네스를 포함한다.
4. 호환성:
   - 기존 server 로직(`chat-turn`, `workflow-runner`, `workflow-ai`)은 최대한 동일한 호출 시그니처로 유지한다.
   - 기존 UI 파트 소비 타입(`types/chat-ui.ts`)은 필요 최소한으로만 수정한다.

## 제안 아키텍처
- `server/utils/codex-client/`
  - `types.ts`: 공통 도메인 타입
  - `index.ts`: 모드 선택 팩토리 + singleton
  - `sdk-client.ts`: 기존 SDK 어댑터
  - `app-server-client.ts`: app-server 하네스 + 이벤트 어댑터
  - `app-server-protocol.ts`: JSON-RPC 전송/응답/요청 처리 공통 유틸
- 모드 선택:
  - `CORAZON_CODEX_CLIENT_MODE` (`app-server` | `sdk`)
  - 기본값은 `app-server` 우선, 실패 시 명시적 에러(묵시적 silent fallback 금지)

## 이벤트/타입 호환 전략
- app-server notification을 내부 공통 이벤트로 매핑한다.
- 기존 렌더러 호환을 위해 다음 항목을 우선 매핑한다.
  - `agentMessage`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`
  - `turn started/completed/failed`, `thread started`
- 추가 이벤트(`collabAgentToolCall`, `dynamicToolCall`)는 확장 지점으로 구조를 열어둔다.

## 리스크
- app-server 프로토콜 변경(특히 experimental surface)로 인한 타입/런타임 불일치
- JSON-RPC server-initiated request(`item/tool/call`, approval) 미처리 시 turn 정지
- 동시 turn 처리 시 이벤트 라우팅 경합

## 완화 전략
- generate-ts 산출물 버전 고정 및 갱신 스크립트 제공
- 요청-응답 correlation/id 추적 로깅 강화
- threadId/turnId 기반 이벤트 라우팅 단위 테스트 추가

## 완료 기준
1. `sdk`/`app-server` 모드 전환이 환경변수로 동작한다.
2. 채팅 스트리밍 및 workflow 실행이 양 모드에서 성공한다.
3. `pnpm typecheck`, `pnpm lint` 통과.
4. 단계별 atomic 커밋으로 히스토리가 분리된다.
