# PRD: Visual Subagents via Unified Chat Stream

## 배경 / 문제 정의
현재 채팅 화면은 부모 에이전트의 `subagent_activity`를 인라인 아이템으로만 보여준다. 이 표현은 서브에이전트의 생성/상태 변화는 알 수 있지만, 실제로 각 서브에이전트가 무엇을 하고 있는지 시각적으로 추적하기 어렵다.

특히 동시에 여러 서브에이전트가 실행될 때는 다음 문제가 있다.
- 각 서브에이전트의 진행 로그를 분리해서 보기 어렵다.
- 메인 채팅 흐름과 서브에이전트 실행 흐름이 섞여 집중도가 떨어진다.
- 리로드/재연결 이후 서브에이전트 실행 상태를 별도 UI로 복원할 수 없다.

## 목표
- `chat/[thread]` 화면에서 실행 중인 서브에이전트를 우측 보조 패널로 시각화한다.
- 우측 패널은 서브에이전트가 하나 이상 활성 상태일 때만 나타난다.
- 우측 패널은 메인 패널보다 작은 기본 폭으로 시작한다.
- 우측 패널 안에서는 서브에이전트를 세로 스플릿으로 쌓아 보여준다.
- 각 서브패널에는 이름과 함께 `user`, `assistant`, `reasoning`, `command_execution`, `mcp_tool_call`, `file_change`, `web_search`, `error` 로그를 스트리밍한다.
- 별도 서브에이전트 전용 HTTP 엔드포인트를 만들지 않고, 기존 `/api/chat` 및 `/api/chat/[runId]/stream` 경로를 그대로 사용한다.
- 리로드/재연결 후에도 기존 채팅 히스토리와 동일한 복원 경로로 서브에이전트 패널 상태를 복원한다.

## 비목표
- 기존 메인 채팅 메시지 렌더링 구조의 전면 재설계
- `subagent_activity` 인라인 카드 제거
- 새로운 저장소 테이블/별도 transcript persistence 도입
- 종료된 서브에이전트 히스토리를 장기 보관하는 별도 UI 추가

## 사용자 경험
- 메인 채팅은 기존처럼 좌측 주 패널에 유지한다.
- 서브에이전트가 없을 때는 채팅 패널만 보인다.
- 서브에이전트가 시작되면 우측 `UDashboardPanel`이 열리고, 기본 분할은 메인 `70`, 서브 `30`으로 시작한다.
- 서브에이전트가 여러 개면 우측 패널은 하나만 유지하고, 내부에서 세로 방향으로 분할한다.
- 서브에이전트가 종료되면 해당 서브패널은 제거된다.
- 마지막 서브패널이 제거되면 우측 패널 전체가 닫힌다.

## 아키텍처 변경점
- 기존 `data-codex-item` 스트림에 숨김용 item kind `subagent_panel`을 추가한다.
- 서버는 부모 스레드 실행 중 활성 서브스레드를 추적하고, 해당 서브스레드의 snapshot + incremental item updates를 메인 UIMessage 스트림에 다중화한다.
- 클라이언트는 별도 fetch 없이 `chat.messages` 안의 `subagent_panel` payload만 읽어 우측 패널을 구성한다.
- 메인 메시지 렌더러는 `subagent_panel`을 본문에 렌더하지 않는다.

## 데이터 계약
### `CodexItemData`
신규 kind 추가:
- `subagent_panel`

payload 계약:
- `threadId: string`
- `name: string`
- `status: CodexSubagentAgentStatus | null`
- `messages: CodexUIMessage[]`

세부 규칙:
- item id는 `subagent-panel:${threadId}`로 고정한다.
- 동일 id는 last-write-wins upsert로 덮어쓴다.
- `messages`는 서브에이전트 transcript 전체 스냅샷이다.
- `messages` 내부의 각 message part는 기존 `text`, `reasoning`, `data-codex-item`을 그대로 사용한다.

## 서버 설계
- `chat-turn.ts`에서 부모 `subagent_activity`를 감시해 활성 서브에이전트 집합을 관리한다.
- 신규 서브에이전트가 감지되면 `thread/read(includeTurns: true)`로 초기 snapshot을 만든다.
- 이후 shared app-server protocol notification을 구독해 해당 subthread의 `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/*`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `item/mcpToolCall/progress`를 추적한다.
- app-server item 해석 로직은 공용 유틸로 분리해 메인 채팅과 서브에이전트 transcript가 동일 규칙을 사용하게 한다.
- 각 서브에이전트 transcript 변경 시 `subagent_panel` item을 같은 writer로 다시 emit 한다.

## 프런트엔드 설계
- `chat/[thread].vue`는 두 개의 형제 `UDashboardPanel`을 사용한다.
- 메인 패널은 `default-size=70`, 우측 패널은 `default-size=30`으로 시작한다.
- 우측 패널 내부는 Reka `SplitterGroup direction="vertical"`을 사용한다.
- 각 `SplitterPanel`은 stable `id`와 `order`를 가진다.
- 우측 패널 전용 composable/computed가 `chat.messages` 내 `subagent_panel` payload를 스캔해 활성 패널 목록을 만든다.
- 서브패널 본문은 `subagent_panel.messages`를 순서대로 렌더링해 기존 message part renderer를 재사용한다.

## 제거 규칙
- 부모 `subagent_activity` 기준 최신 상태가 `pendingInit`, `running`, 또는 생성 직후 상태 미정이면 유지한다.
- `interrupted`, `completed`, `errored`, `shutdown`, `notFound`가 되면 제거한다.
- 종료된 subthread의 transcript payload가 히스토리에 남아 있어도, 우측 패널 렌더링은 활성 상태 기준으로 필터링한다.

## 리스크
- 기존 client dedupe/update 로직이 메인 assistant message 내부 `data-codex-item`만 가정하고 있어, `subagent_panel` 추가 시 저장/복원/재연결 경계에서 중복 갱신 이슈가 생길 수 있다.
- subthread snapshot과 live notifications 사이 타이밍 경합으로 초기 로그 중복이 생길 수 있다.
- 세로 분할 패널의 동적 add/remove 시 `order`가 불안정하면 Splitter 레이아웃이 깨질 수 있다.
- transcript 전체 스냅샷을 반복 emit 하므로 서브에이전트 로그가 길 경우 payload 크기가 증가한다.

## 완화 전략
- `subagent_panel` item id를 고정하고, DB normalization과 client item patching 모두 id 기반 upsert를 사용한다.
- snapshot 직후부터 live 이벤트를 붙이되, item id 단위 덮어쓰기로 중복을 흡수한다.
- Splitter 패널에는 항상 stable `threadId` 기반 `id`와 인덱스 기반 `order`를 준다.
- 종료된 서브에이전트는 즉시 패널에서 제거해 장시간 누적을 막는다.

## 구현 체크리스트
- [ ] 브랜치 생성: `feat/visual-subagents`
- [x] PRD 문서 생성: `docs/PRD_VISUAL_SUBABENTS.md`
- [ ] `CodexItemData`에 `subagent_panel` kind 추가
- [ ] app-server item 정규화 로직 공용 유틸 분리
- [ ] subthread snapshot builder 추가
- [ ] 부모 스트림에 subagent panel payload 다중화
- [ ] message builder / DB normalization에서 `subagent_panel` upsert 지원
- [ ] 메인 message renderer에서 `subagent_panel` 숨김 처리
- [ ] 채팅 우측 패널 및 vertical splitter UI 구현
- [ ] 활성 subagent 파생 상태 로직 구현
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] 수동 시나리오 검증

## 커밋 계획
1. `docs: add visual subagents PRD`
2. `refactor: multiplex subagent panels into chat stream`
3. `feat: render visual subagent side panel in chat`
4. 필요 시 `fix:` 커밋 추가

## 검증 시나리오 / 완료 기준
1. 서브에이전트 1개 생성 시 우측 패널이 열리고 메인보다 작은 폭으로 시작한다.
2. 서브에이전트 2개 이상 생성 시 우측 패널은 하나만 유지되고 내부에서 vertical split 된다.
3. `assistant`, `reasoning`, `command`, `tool/file/web/error` 로그가 각 서브패널에서 스트리밍된다.
4. 서브에이전트 종료 상태 전환 시 해당 패널만 제거된다.
5. 마지막 서브에이전트 제거 시 우측 패널 전체가 닫힌다.
6. 페이지 리로드 후 `/api/chat/history/:threadId`와 `/api/chat/[runId]/stream`만으로 서브패널이 복원된다.
7. 메인 채팅과 기존 `subagent_activity` 인라인 카드가 회귀하지 않는다.
8. `pnpm lint`, `pnpm typecheck`를 통과한다.
