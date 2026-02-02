# Project Instructions

- Use Nuxt 4 aliasing correctly: in `app/**/*.ts` and `app/**/*.vue`, `@`/`~` resolve from `app/`; in `server/**/*.ts`, `@`/`~` resolve from `server/`. Use `@@`/`~~` for project-root paths. For example, when importing shared root files (for example `types/codex-ui.ts`) from the app bundle, use `@@/types/codex-ui`.
- Functions exported from `server/utils` are auto-imported in `server/**`; do not add manual imports for them.
- UI work must be implemented with Nuxt UI components and Nuxt UI MCP references when needed.
- You can check for additional type errors and lint issues with `pnpm typecheck` and `pnpm lint`. After all edits are complete, run both commands to validate code quality.
- Keep changes focused; avoid documenting project structure here.
