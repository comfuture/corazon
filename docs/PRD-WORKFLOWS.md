# PRD: Custom Workflows

## 배경
사용자가 미리 정의한 워크플로 지시문을 스케줄/주기/직접 실행 트리거로 실행하고, 채팅 스레드와 분리된 실행 이력을 조회/관리할 수 있는 기능이 필요하다.

## 목표
- `workflows/*.md` 기반 워크플로 정의 로드/검증/스케줄링
- `/workflows`, `/workflows/:name`에서 생성/조회/수정/삭제/수동 실행
- 실행 이력은 `runs` 테이블로 분리 저장
- 실행 메시지 본문은 DB에 저장하지 않고 `sessions/*.jsonl` 파일 경로만 참조
- 세션 파일 유실 시 대체 화면 제공

## 비목표
- 외부 웹훅 트리거 구현
- 멀티 인스턴스 중복 실행 방지
- 장수명 멀티턴 워크플로 세션

## 워크플로 파일 포맷

```md
---
name: workflow name
description: |
  lorem ipsum
on:
  schedule: 0 18 * * *
  workflow-dispatch: true
skills:
  - telegram
---
Brief my daily schedule to my telegram.
```

규칙:
- frontmatter 필수: `name`, `description`, `on`, `skills`
- 시간 트리거는 `schedule` 또는 `interval` 중 하나만 허용
- `interval` 문법: `^([1-9][0-9]*)(s|m|h)$`
- 시간 트리거가 없으면 `workflow-dispatch: true` 필수
- 본문(markdown body) 비어 있으면 오류

## 실행/스케줄링
- 스케줄러: `toad-scheduler`
  - cron: `CronJob`
  - interval: `SimpleIntervalJob`
- 앱 시작 시 `workflows/*.md` 전량 로드 및 유효 항목 스케줄 등록
- 생성/수정/삭제 시 즉시 reschedule
- job id: `workflow:{fileSlug}:{trigger}`

## 실행 컨텍스트 주입
워크플로 실행 시 프롬프트 앞에 다음을 주입:

```text
실행시 아래 실행 콘텍스트를 참조해야 합니다.

<run-context>
current_date: YYYY-MM-DD
current_datetime_iso: ...
timezone: ...
workflow_name: ...
workflow_description: ...
workflow_file: workflows/<slug>.md
trigger_type: schedule|interval|workflow-dispatch
trigger_value: ...
working_directory: ...
allowed_skills: ...
</run-context>
```

## 데이터 모델
`runs` 테이블:
- `id`
- `workflow_name`
- `workflow_file_slug`
- `trigger_type`
- `trigger_value`
- `status`
- `started_at`
- `completed_at`
- `total_input_tokens`
- `total_cached_input_tokens`
- `total_output_tokens`
- `session_thread_id`
- `session_file_path`
- `error_message`

인덱스:
- `(workflow_file_slug, started_at DESC)`

## API
- `GET /api/workflows`
- `POST /api/workflows`
- `GET /api/workflows/:name`
- `PUT /api/workflows/:name`
- `DELETE /api/workflows/:name`
- `POST /api/workflows/:name/run`
- `POST /api/workflows/enhance`
- `POST /api/workflows/parse-trigger`
- `GET /api/workflows/runs/:runId/history`

## UX
- 사이드바 threads 위에 `/workflows` 링크
- `/workflows`:
  - 목록
  - 2-step 생성 다이얼로그
  - step1: 지시 입력 textarea + enhance 버튼
  - step2: trigger 라디오(cron/interval), 값 입력, dispatch 스위치, skills 체크박스
- `/workflows/:name`:
  - 단일 편집 페이지
  - frontmatter 필드 + 지시문 + 실행 이력

## 트리거 추론
- 1차 정규식 파싱(한/영 시간 표현)
- 2차 AI structured output 보정(불확실 시 미적용)
- `매일 오후 6시`는 기본 `0 18 * * *`

## 체크리스트
- [x] 브랜치 생성: `feat/workflows`
- [x] PRD 문서 작성
- [ ] 의존성 추가 (`toad-scheduler`)
- [ ] 타입 추가 (`types/workflow.ts`)
- [ ] DB `runs` 스키마 및 CRUD 유틸
- [ ] 워크플로 파서/검증/직렬화 유틸
- [ ] 스케줄 매니저
- [ ] 실행 러너 + run-context 주입
- [ ] 워크플로 CRUD/실행/이력/enhance/parse-trigger API
- [ ] `/workflows` 목록/생성 UI
- [ ] `/workflows/:name` 편집/이력 UI
- [ ] 사이드바 링크 추가
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`

## 완료 기준
- 유효 워크플로는 자동 스케줄 등록
- UI 생성/수정이 문법 유효한 `.md` 파일 생성
- 수동 실행 가능(허용된 워크플로만)
- 실행 이력에 토큰 사용량/상태/세션 참조 저장
- 세션 파일 유실 시 대체 안내 화면 표시
