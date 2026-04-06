export type AuthSeedMode = 'link' | 'copy-once'

export interface EnsureCopiedAuthFileOptions {
  sourcePath: string
  destinationPath: string
  overwrite?: boolean
  skipIfExistingNonSymlink?: boolean
  onSkip?: () => void
  onCopy?: () => void
}

export declare const resolveAuthSeedMode: (rawMode?: string | undefined) => AuthSeedMode

export declare const ensureCopiedAuthFile: (
  options: EnsureCopiedAuthFileOptions
) => 'copied' | 'skipped' | 'missing-source'
