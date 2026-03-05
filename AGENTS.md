# Project Instructions

- Use Nuxt 4 aliasing correctly: in `app/**/*.ts` and `app/**/*.vue`, `@`/`~` resolve from `app/`; in `server/**/*.ts`, `@`/`~` resolve from `server/`. Use `@@`/`~~` for project-root paths. For example, when importing shared root files (for example `types/codex-ui.ts`) from the app bundle, use `@@/types/codex-ui`.
- Functions exported from `server/utils` are auto-imported in `server/**`; do not add manual imports for them.
- UI work must be implemented with Nuxt UI components and Nuxt UI MCP references when needed.
- You do not need to run `pnpm check` and `pnpm lint` on every edit turn. Run both commands before committing, and fix any reported errors before creating the commit.
- Keep changes focused; avoid documenting project structure here.
