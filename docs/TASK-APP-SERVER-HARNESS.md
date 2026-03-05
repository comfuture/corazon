# Task: App Server Harness 전환 실행 계획

## Phase 0: 문서/스코프 고정
- [x] PRD 문서 작성 (`docs/PRD-APP-SERVER-HARNESS.md`)
- [ ] 구현 체크리스트 작성 (본 문서)

## Phase 1: 의존성/타입 기반 정비
- [ ] `@openai/codex-sdk` 최신 안정 버전 업데이트
- [ ] lockfile 반영
- [ ] app-server 타입 생성 경로 확정
- [ ] `codex app-server generate-ts --experimental` 실행
- [ ] 생성 타입을 레포 관리 형태로 반영 (스크립트 포함)

## Phase 2: 공통 클라이언트 인터페이스 도입
- [ ] `server/utils/codex-client/types.ts` 추가
- [ ] `server/utils/codex-client/index.ts` 팩토리 추가
- [ ] 기존 SDK 어댑터(`sdk-client.ts`) 구현
- [ ] 기존 `getCodex()` 중복 구현 제거

## Phase 3: app-server 하네스 구현
- [ ] stdio JSON-RPC transport 구현
- [ ] initialize/initialized handshake 구현
- [ ] request-response correlation 구현
- [ ] server notification/event emitter 구현
- [ ] server request 처리 훅 구현 (`item/tool/call`, approval, requestUserInput)
- [ ] thread/start, thread/resume, turn/start 래핑 구현
- [ ] app-server 이벤트 -> 공통 이벤트 어댑터 구현

## Phase 4: 기능 경로 전환
- [ ] `server/utils/chat-turn.ts`를 공통 클라이언트로 전환
- [ ] `server/utils/workflow-runner.ts`를 공통 클라이언트로 전환
- [ ] `server/utils/workflow-ai.ts`를 공통 클라이언트로 전환
- [ ] `server/utils/stream.ts` 매핑 보강 (필요시 camel/snake 정규화)
- [ ] `types/chat-ui.ts` 타입 의존 재정리 (SDK 직결 완화)

## Phase 5: 모드 선택/설정
- [ ] `CORAZON_CODEX_CLIENT_MODE` 환경변수 도입
- [ ] 기본 모드 설정 (`app-server`)
- [ ] startup 로그/오류 메시지 정리

## Phase 6: 검증/정리
- [ ] 수동 시나리오: 신규 thread turn
- [ ] 수동 시나리오: resume thread turn
- [ ] 수동 시나리오: workflow run
- [ ] 수동 시나리오: outputSchema 사용 경로
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`

## 커밋 계획 (Atomic)
1. `docs: add app-server harness PRD and task checklist`
2. `chore: upgrade codex sdk and add app-server type generation script`
3. `refactor: add codex client abstraction with sdk adapter`
4. `feat: implement app-server json-rpc harness and adapter`
5. `refactor: migrate chat/workflow flows to codex client abstraction`
6. `feat: add runtime mode selection for sdk vs app-server`
7. `chore: finalize validations and cleanup`
