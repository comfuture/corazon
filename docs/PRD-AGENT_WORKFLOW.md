# PRD: Agent Workflow 기반 내구성 스트리밍 리팩토링

## 배경 / 문제 정의
현재 채팅 스트림은 요청-응답 연결에 강하게 결합되어 있어, 브라우저 리로드/네트워크 단절 시 진행 중 응답이 끊길 수 있다. 특히 Codex 이벤트 스트림이 서버 연결 단절과 함께 소실되어, 사용자 입장에서 응답 연속성이 깨진다.

## 목표
- 브라우저 리로드 후에도 진행 중인 에이전트 응답 스트림을 이어받는다.
- `threadId`를 기준으로 히스토리와 활성 워크플로우 run을 복원한다.
- Codex 이벤트/아이템 렌더링 규약(`data-codex-event`, `data-codex-item`)을 유지한다.

## 비목표
- 멀티턴 hook 기반 단일 장수명 워크플로우 세션 도입
- 메시지 렌더링 UI 구조/디자인 변경
- 기존 토큰 집계/스레드 목록 UX 재설계

## 아키텍처 변경점
- `POST /api/chat`는 Codex를 직접 실행하지 않고 워크플로우 run을 시작한다.
- Codex 실행 본문은 `server/utils/chat-turn.ts`로 분리한다.
- 워크플로우 `server/workflows/chat-turn.ts`에서 step이 Codex 스트림 청크를 `getWritable()`로 전달한다.
- 클라이언트는 `WorkflowChatTransport`를 사용해 런 재연결을 수행한다.

## API 계약
### POST `/api/chat`
- 요청: `threadId`, `resume`, `attachmentUploadId`, `skipGitRepoCheck`, `model`, `messages`
- 응답: UIMessage 스트림
- 헤더: `x-workflow-run-id` 필수

### GET `/api/chat/:runId/stream`
- 쿼리: `startIndex`
- 동작: `getRun(runId).getReadable({ startIndex })`
- 용도: 리로드/단절 후 재구독

### GET `/api/chat/history/:threadId`
- 응답:
  - `messages: CodexUIMessage[]`
  - `activeRunId: string | null`

## 데이터 모델 변경
SQLite `threads` 테이블 컬럼 추가:
- `active_run_id TEXT`
- `active_run_updated_at INTEGER`

유틸 추가:
- `setThreadActiveRun(threadId, runId, updatedAt?)`
- `clearThreadActiveRun(threadId, runId?)`
- `getThreadActiveRun(threadId)`

동작 규칙:
- run 시작 시 스레드의 `active_run_id`를 설정
- run 종료 시(동일 runId 조건) `active_run_id` 해제
- 히스토리 조회 시 `active_run_id` 반환

## 구현 상세 체크리스트
- [x] 브랜치 생성: `feat/implement-agent-workflow`
- [x] PRD 문서 생성
- [x] 의존성 추가: `workflow`, `@workflow/ai`
- [x] Nuxt 모듈 추가: `workflow/nuxt`
- [x] 타입 추가: `CodexChatHistoryResponse`, `CodexChatWorkflowInput`
- [x] DB 스키마/유틸 확장 (`active_run_id`, `active_run_updated_at`)
- [x] Codex 실행 로직 분리 (`server/utils/chat-turn.ts`)
- [x] 워크플로우 추가 (`server/workflows/chat-turn.ts`)
- [x] `/api/chat`를 `start()` 기반으로 전환
- [x] `/api/chat/[runId]/stream.get.ts` 추가
- [x] 히스토리 응답 확장 (`messages + activeRunId`)
- [x] `useCodexChat`를 `WorkflowChatTransport` 기반으로 전환
- [x] 타입체크 실행 (`pnpm typecheck`)
- [x] 린트 실행 (`pnpm lint`)
- [x] 수동 E2E 시나리오 점검

## 리스크 / 롤백 전략
### 리스크
- transport 요청 바디 주입이 기존 `sendMessage(..., { body })`와 달라 회귀 가능성
- run/thread 매핑 타이밍(`thread.started` 이전/이후) 경쟁 상태
- 스트림 종료 청크(`finish`) 전파 누락 시 재연결 루프

### 롤백
- `server/api/chat.ts`를 이전 direct Codex 스트리밍 구현으로 즉시 되돌림
- `WorkflowChatTransport`를 제거하고 기본 Chat transport 복귀
- DB 추가 컬럼은 읽기 무해하므로 유지 가능

## 검증 시나리오 / 완료 기준
1. 신규 스레드 생성 중 리로드 후 스트림 이어받기
2. 기존 스레드 후속 질문 중 리로드 후 이어받기
3. 네트워크 단절 후 `startIndex` 기반 중복 없는 재연결
4. 완료 이후 재접속 시 불필요한 재연결 루프 없음
5. 첨부파일 요청에서도 메시지 저장/경로 리라이트 정합성 유지
6. 모델 선택 및 `skipGitRepoCheck`, `resume` 회귀 없음

완료 기준:
- 위 기능 동작
- `pnpm typecheck` 통과
- `pnpm lint` 통과
