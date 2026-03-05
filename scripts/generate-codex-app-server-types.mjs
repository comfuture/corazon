import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = resolve(repoRoot, 'types', 'codex-app-server')

const resolveCodexBin = async () => {
  const sdkEntryUrl = await import.meta.resolve('@openai/codex-sdk')
  const sdkEntryPath = fileURLToPath(sdkEntryUrl)
  const sdkRequire = createRequire(sdkEntryPath)
  return sdkRequire.resolve('@openai/codex/bin/codex.js')
}

const run = async () => {
  const codexBin = await resolveCodexBin()

  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })

  const result = spawnSync(
    process.execPath,
    [codexBin, 'app-server', 'generate-ts', '--experimental', '--out', outputDir],
    {
      cwd: repoRoot,
      stdio: 'inherit'
    }
  )

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }

  console.log(`Generated app-server types in: ${outputDir}`)
}

await run()
