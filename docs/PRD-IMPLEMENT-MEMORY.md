# PRD: Mem0 + ChromaDB 기반 Shared Memory 고도화

## 배경
- 현재 `shared-memory`는 `${CODEX_HOME}/MEMORY.md` 파일을 직접 읽고 쓰는 pseudo 메모리 방식이다.
- 스레드 단위 대화 데이터는 SQLite(`threads`, `messages`)에 저장되지만, 장기 기억 검색/회상/업데이트는 벡터 기반이 아니다.
- Codex SDK 메시지 포맷(`CodexUIMessage[]`)은 OpenAI 호환 `message[]`와 구조가 달라 장기 메모리 시스템에 바로 입력하기 어렵다.

## 목표
- `mem0` OSS(`mem0ai/oss`)로 shared memory를 전면 전환한다.
- 벡터스토어는 ChromaDB 백엔드를 사용한다.
- `@langchain/community` 없이 Chroma JS SDK 직접 어댑터로 벡터스토어를 연결한다.
- 메모리 읽기/쓰기 API는 코어 로직(`server/utils`)에 구현하고, 외부 호출용 HTTP API(`/api/memory/*`)를 제공한다.
- `shared-memory` 스킬은 코어 API(HTTP 경유)를 이용하는 래퍼로 전환한다.
- 대화가 15분 이상 비활성(stale)인 스레드를 주기적으로 메모리에 적재한다.
- stale 적재 시 `CodexUIMessage[]`의 텍스트 파트를 OpenAI 호환 `message[]`로 변환한다.
- `templates/agent-behavior.md`에 기억 추가/회상 시 shared-memory 활용 규칙을 반영한다.

## 비목표
- 기존 `MEMORY.md` 내용을 자동 마이그레이션하는 기능
- 멀티 인스턴스 분산 락/중복 실행 방지
- 사용자별 메모리 분리 UI 제공

## 아키텍처 개요
1. `server/utils/memory.ts`
 - mem0 OSS 초기화(singleton)
 - mem0 `VectorStoreFactory`에 `chromadb` provider 주입
 - remember/search 코어 함수
 - Codex 메시지 -> OpenAI 메시지 변환 함수
2. `server/utils/mem0-chromadb-store.ts`
 - `chromadb` JS client 기반 mem0 vector store 어댑터(langchain 미사용)
 - insert/search/get/update/delete/list 구현
2. `server/api/memory/*`
 - health/search/remember 엔드포인트
 - shared-memory 스킬과 외부 호출에서 사용
3. `server/utils/memory-sync.ts`
 - stale 스레드 스캔 + mem0 적재 주기 작업
4. `server/plugins/memory-sync.server.ts`
 - 서버 시작 시 동기화 워크플로우 초기화
5. `templates/skills/shared-memory/*`
 - 파일 직접 조작 제거
 - Corazon 메모리 API 호출 방식으로 전환

## 데이터 모델 변경
`threads` 테이블 컬럼 추가:
- `memory_synced_source_updated_at INTEGER`
 - 마지막으로 메모리 적재 완료된 기준 `threads.updated_at`
- `memory_last_synced_at INTEGER`
 - 마지막 메모리 동기화 시각
- `memory_sync_error TEXT`
 - 최근 동기화 실패 메시지

stale 대상 조건:
- `updated_at <= now - 15m`
- `active_run_id IS NULL`
- `memory_synced_source_updated_at IS NULL OR memory_synced_source_updated_at < updated_at`

## 메시지 변환 규칙
입력: `CodexUIMessage[]`

변환:
- `role`이 `user|assistant|system`인 메시지만 대상
- `parts` 중 `type === 'text'`인 항목만 추출
- 텍스트 파트를 줄바꿈(`\n`)으로 join하여 `content` 구성
- `content`가 빈 문자열이면 해당 메시지 제외

출력:
- OpenAI 호환 `Array<{ role, content }>`

## 벡터스토어 구성
- Chroma 서버 연결값:
  - `CORAZON_MEMORY_CHROMA_URL` (기본: `http://127.0.0.1:8000`)
  - `CORAZON_MEMORY_CHROMA_COLLECTION` (기본: `mem0`)
  - 선택: `CORAZON_MEMORY_CHROMA_API_KEY`, `CORAZON_MEMORY_CHROMA_TENANT`, `CORAZON_MEMORY_CHROMA_DATABASE`
- 참고 문서: `https://docs.mem0.ai/components/vectordbs/dbs/chroma`

## API 계약
### GET `/api/memory/health`
- 목적: 메모리 엔진 초기화 가능 상태 확인
- 응답:
```json
{
  "ok": true,
  "configured": true,
  "vectorStore": "chromadb",
  "chromaUrl": "http://127.0.0.1:8000",
  "chromaCollection": "mem0",
  "userId": "corazon-shared"
}
```

### POST `/api/memory/search`
- 요청:
```json
{
  "query": "사용자 선호",
  "limit": 5,
  "filters": {}
}
```
- 응답:
```json
{
  "results": [
    {
      "id": "mem-id",
      "memory": "사용자는 간결한 답변을 선호한다.",
      "score": 0.89,
      "metadata": {}
    }
  ]
}
```

### POST `/api/memory/remember`
- 요청:
```json
{
  "text": "사용자는 한국어 답변을 선호한다.",
  "threadId": "019c...",
  "section": "Preferences",
  "metadata": {}
}
```
또는
```json
{
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "threadId": "019c..."
}
```
- 응답:
```json
{
  "memories": [
    {
      "id": "mem-id",
      "memory": "..."
    }
  ]
}
```

## 에러 처리
- `OPENAI_API_KEY` 미설정: 500 + 명시적 메시지
- 잘못된 요청 형식: 400
- mem0 처리 실패: 500, `statusMessage`에 원인 전달
- stale 동기화 실패: `threads.memory_sync_error` 저장 후 다음 주기에 재시도

## 구현 단계
1. PRD 문서 작성
2. dotenv 선로딩 플러그인 추가
3. mem0 + chromadb provider 코어 유틸 구현
4. memory API 추가
5. DB 스키마/조회 유틸 확장
6. stale 스레드 동기화 워크플로우 추가(15분 주기)
7. shared-memory 스킬 전환
8. agent behavior 업데이트
9. 검증(typecheck/lint + 기능 확인)

## 원자 커밋 계획
1. `docs: add mem0 memory PRD and verification checklist`
2. `feat: add dotenv bootstrap and mem0 chromadb memory service`
3. `feat: expose memory APIs and add thread memory sync columns`
4. `feat: add stale thread memory sync workflow`
5. `feat: migrate shared-memory skill to memory APIs`
6. `docs: update agent behavior memory guidance`

## 검증 체크리스트
- [ ] 서버 시작 시 `.env` 로드 후 `OPENAI_API_KEY` 인식
- [ ] ChromaDB URL/컬렉션 설정 반영
- [ ] 프로젝트 직접 의존성에서 `@langchain/community` 미사용 유지
- [ ] `GET /api/memory/health` 정상 응답
- [ ] `POST /api/memory/remember`(text) 저장 성공
- [ ] `POST /api/memory/search`로 저장한 기억 검색 가능
- [ ] `CodexUIMessage[]` -> OpenAI `message[]` 변환에서 text part만 반영
- [ ] stale 스레드(15분+)만 메모리 동기화 대상
- [ ] 동기화 성공 시 `memory_synced_source_updated_at` 갱신
- [ ] 동기화 실패 시 `memory_sync_error` 저장
- [ ] `shared-memory` 스크립트 ensure/search/upsert가 memory API로 동작
- [ ] `templates/agent-behavior.md`에 shared-memory 사용 규칙 반영
- [ ] `pnpm typecheck` 통과
- [ ] `pnpm lint` 통과
