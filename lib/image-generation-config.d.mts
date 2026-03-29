export type NormalizeImageGenerationFeatureConfigResult = {
  changed: boolean
  output: string
}

export function normalizeImageGenerationFeatureConfig(
  original: string
): NormalizeImageGenerationFeatureConfigResult
