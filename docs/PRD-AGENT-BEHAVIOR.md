# PRD: Agent Behavior 전환 (`.codex` -> `.corazon`)

## 배경 / 문제
- 현재 Corazon은 Codex 동작을 사실상 `.codex` 중심으로 사용한다.
- 앱 전용 기본 동작을 분리하고 관리하기 위해 `.corazon`을 Codex home으로 사용해야 한다.
- 단, 사용자 인증은 재로그인 부담 없이 유지되어야 한다.

## 목표
- Codex SDK 실행 시 기본 홈을 `.corazon`으로 고정한다.
- 최초 실행(또는 파일 부재) 시 `.codex`의 핵심 파일/디렉토리를 `.corazon`으로 seed 한다.
- `config.toml`은 복사(수정 가능), `auth.json`은 심볼릭 링크(인증 공유)로 처리한다.
- `settings/mcp`, `settings/skill` 화면/API를 제공해 웹에서 설정을 관리한다.

## 비목표
- `.codex` 전체 미러링/동기화(세션/로그/히스토리 포함)
- `config.toml` 자동 병합
- 스킬 마켓/큐레이션 카탈로그 구축

## 경로/초기화 정책
- 우선순위:
1. `CORAZON_ROOT_DIR`
2. 기존 `~/.corazon` 존재 시 해당 경로
3. OS별 기본 경로

- OS별 기본 경로:
1. macOS: `~/Library/Application Support/Corazon`
2. Linux: `${XDG_CONFIG_HOME:-~/.config}/corazon`
3. Windows: `%APPDATA%/Corazon`

- seed 정책(대상 파일/디렉토리가 없을 때만):
1. 파일 복사: `config.toml`
2. 디렉토리 복사: `skills`, `rules`, `vendor_imports`
3. 심볼릭 링크: `auth.json`
4. 생성: `.corazon/AGENTS.md` (Corazon 고정 템플릿)
5. 생성: `data/`, `threads/`

## 아키텍처 변경점
- `server/utils/agent-home.ts`: runtime root 해석
- `server/utils/agent-bootstrap.ts`: seed/link/bootstrap
- `server/plugins/db.server.ts`: DB init 전에 bootstrap 실행
- `server/utils/chat-turn.ts`: Codex SDK `env.CODEX_HOME` 강제 오버라이드
- setup/docker 스크립트: `.corazon` 루트 기준 동작으로 변경

## API 설계
- `GET /api/settings/agent-home`
  - 현재 agent home 경로 + 주요 파일 경로 반환
- `GET /api/settings/mcp`
  - `config.toml`의 `mcp_servers` 반환
- `PUT /api/settings/mcp`
  - `mcp_servers` 전체 갱신
- `GET /api/settings/skill`
  - `.corazon/skills` 목록 반환
- `POST /api/settings/skill/install`
  - Git URL/로컬 경로에서 스킬 설치
- `DELETE /api/settings/skill/:name`
  - 특정 스킬 삭제

## 리스크
- TOML 재저장 시 포맷/주석 손실 가능
- 잘못된 스킬 소스 설치 시 불완전 상태
- Docker 환경에서 경로 변경으로 인한 설정 누락

## 검증 시나리오
1. `.corazon/config.toml` 부재 상태로 실행 -> `~/.codex/config.toml` 복사
2. `.corazon/skills` 부재 상태 -> seed 복사
3. `.corazon/auth.json` 심볼릭 링크 생성
4. 기존 `.corazon/config.toml` 존재 시 유지(덮어쓰기 없음)
5. MCP CRUD 저장 후 재조회 일치
6. Skill 설치(로컬/Git) 성공 + `SKILL.md` 없는 소스 실패
7. Skill 삭제 정상 동작
8. 채팅 실행 시 `.corazon` 기반 `CODEX_HOME`으로 Codex 실행
9. `pnpm typecheck`, `pnpm lint` 통과

## 구현 체크리스트
- [x] PRD 문서 생성
- [x] agent home 경로 해석 유틸 추가
- [x] bootstrap 유틸 추가 및 서버 시작 시 적용
- [x] Codex SDK `CODEX_HOME` 오버라이드
- [x] setup 스크립트 `.corazon` seed 정책으로 전환
- [x] docker entrypoint/env 경로 전환
- [x] settings 타입 정의 추가
- [x] TOML 파서/writer 의존성 추가
- [x] settings/mcp API 구현
- [x] settings/skill API 구현
- [x] settings/mcp UI 구현
- [x] settings/skill UI 구현
- [x] settings navigation 확장
- [x] 관련 문구/문서 업데이트
- [x] typecheck/lint 통과
