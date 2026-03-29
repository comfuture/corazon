import test from 'node:test'
import assert from 'node:assert/strict'
import { parse } from '@iarna/toml'

import { normalizeImageGenerationFeatureConfig } from '../lib/image-generation-config.mjs'

const assertNormalizedToTrue = (input, options = {}) => {
  const { changed, output } = normalizeImageGenerationFeatureConfig(input)

  assert.equal(typeof output, 'string')
  assert.ok(output.endsWith('\n'))
  assert.equal(changed, options.expectedChanged ?? true)

  const parsed = parse(output)
  assert.equal(parsed.features.image_generation, true)
}

test('normalizes [features] header with inline comment and false value', () => {
  const input = '[features] # keep-comment\nimage_generation = false\n'
  const { output } = normalizeImageGenerationFeatureConfig(input)

  assertNormalizedToTrue(input)
  assert.equal((output.match(/\[features\]/g) ?? []).length, 1)
  assert.equal((output.match(/image_generation\s*=/g) ?? []).length, 1)
})

test('normalizes quoted image_generation key in [features] section', () => {
  const input = '[features]\n"image_generation" = false\n'
  const { output } = normalizeImageGenerationFeatureConfig(input)

  assertNormalizedToTrue(input)
  assert.equal((output.match(/image_generation\s*=/g) ?? []).length, 1)
})

test('normalizes dotted features.image_generation key without appending [features]', () => {
  const input = 'features.image_generation = false\n'
  const { output } = normalizeImageGenerationFeatureConfig(input)

  assertNormalizedToTrue(input)
  assert.equal((output.match(/\[features\]/g) ?? []).length, 0)
  assert.equal((output.match(/features\.image_generation\s*=/g) ?? []).length, 1)
})

test('adds root-level dotted key before later tables when features.* exists without image_generation', () => {
  const input = 'features.foo = "bar"\n[server]\nport = 8080\n'
  const { output } = normalizeImageGenerationFeatureConfig(input)
  const parsed = parse(output)

  assert.equal(parsed.features.foo, 'bar')
  assert.equal(parsed.features.image_generation, true)
  assert.equal(parsed.server.port, 8080)
  assert.equal(parsed.server.features, undefined)
  assert.match(output, /features\.image_generation = true\n\[server\]/)
})

test('does not treat nested table features.* key as root features table', () => {
  const input = '[server]\nfeatures.foo = "bar"\n'
  const { output } = normalizeImageGenerationFeatureConfig(input)
  const parsed = parse(output)

  assert.equal(parsed.server.features.foo, 'bar')
  assert.equal(parsed.server.features.image_generation, undefined)
  assert.equal(parsed.features.image_generation, true)
  assert.match(output, /\[features\]\nimage_generation = true/)
})

test('normalizes literal-quoted dotted features key without appending [features]', () => {
  const input = '\'features\'.\'image_generation\' = false\n'
  const { output } = normalizeImageGenerationFeatureConfig(input)

  assertNormalizedToTrue(input)
  assert.equal((output.match(/\[features\]/g) ?? []).length, 0)
  assert.equal((output.match(/features\.image_generation\s*=/g) ?? []).length, 1)
})

test('normalizes inline features table key without adding duplicate feature table', () => {
  const input = 'features = { image_generation = false }\n'
  const { output } = normalizeImageGenerationFeatureConfig(input)

  assertNormalizedToTrue(input)
  assert.equal((output.match(/\[features\]/g) ?? []).length, 0)
  assert.equal((output.match(/features\s*=\s*\{/g) ?? []).length, 1)
})

test('adds [features] section when missing entirely', () => {
  const input = 'name = "corazon"\n'
  const { output } = normalizeImageGenerationFeatureConfig(input)

  assertNormalizedToTrue(input)
  assert.match(output, /\[features\]/)
  assert.match(output, /image_generation = true/)
})

test('keeps already-correct config unchanged', () => {
  const input = '[features]\nimage_generation = true\n'
  assertNormalizedToTrue(input, { expectedChanged: false })
})
