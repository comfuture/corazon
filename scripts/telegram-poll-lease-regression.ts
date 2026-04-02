import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'corazon-lease-regression-'))
  const tempRuntimeRoot = join(tempRoot, 'runtime')

  process.env.CORAZON_ROOT_DIR = tempRoot
  process.env.CORAZON_RUNTIME_ROOT_DIR = tempRuntimeRoot
  process.env.CORAZON_THREADS_DIR = join(tempRuntimeRoot, 'threads')

  try {
    const {
      acquireTelegramPollLease,
      getTelegramTransportState,
      renewTelegramPollLease,
      upsertTelegramTransportState
    } = await import('../server/utils/db.ts')

    const key = 'telegram-lease-regression'
    const initialNow = 1_000_000

    const acquiredByA = acquireTelegramPollLease({
      key,
      pollerId: 'poller-a',
      leaseExpiresAt: initialNow + 60_000,
      updatedAt: initialNow
    })
    assert.equal(acquiredByA.acquired, true, 'poller-a should acquire the initial lease')

    const staleOverwriteAttempt = upsertTelegramTransportState({
      key,
      pollerId: 'poller-b',
      pollerLeaseExpiresAt: initialNow + 70_000,
      lastPollError: 'should not overwrite active owner',
      updatedAt: initialNow + 1_000
    })
    assert.equal(
      staleOverwriteAttempt?.pollerId,
      'poller-a',
      'stale poller should not overwrite active lease owner'
    )
    assert.equal(
      staleOverwriteAttempt?.pollerLeaseExpiresAt,
      initialNow + 60_000,
      'lease expiration should remain unchanged for stale overwrite attempts'
    )

    const metadataOnlyUpdate = upsertTelegramTransportState({
      key,
      lastPollError: 'metadata update',
      updatedAt: initialNow + 2_000
    })
    assert.equal(
      metadataOnlyUpdate?.pollerId,
      'poller-a',
      'metadata-only upsert must not clear lease owner'
    )
    assert.equal(
      metadataOnlyUpdate?.pollerLeaseExpiresAt,
      initialNow + 60_000,
      'metadata-only upsert must not clear lease expiry'
    )

    const takeoverAfterExpiry = upsertTelegramTransportState({
      key,
      pollerId: 'poller-b',
      pollerLeaseExpiresAt: initialNow + 120_000,
      updatedAt: initialNow + 61_000
    })
    assert.equal(
      takeoverAfterExpiry?.pollerId,
      'poller-b',
      'new poller should take over after lease expiry'
    )

    const renewalByStaleOwner = renewTelegramPollLease({
      key,
      pollerId: 'poller-a',
      leaseExpiresAt: initialNow + 180_000,
      updatedAt: initialNow + 62_000
    })
    assert.equal(
      renewalByStaleOwner.renewed,
      false,
      'stale owner must not renew lease after takeover'
    )

    const renewalByCurrentOwner = renewTelegramPollLease({
      key,
      pollerId: 'poller-b',
      leaseExpiresAt: initialNow + 180_000,
      updatedAt: initialNow + 63_000
    })
    assert.equal(
      renewalByCurrentOwner.renewed,
      true,
      'current owner should renew lease successfully'
    )
    assert.equal(
      getTelegramTransportState(key)?.pollerLeaseExpiresAt,
      initialNow + 180_000,
      'renewal should advance lease expiry for current owner'
    )

    const transportSource = readFileSync(
      new URL('../server/utils/telegram-transport.ts', import.meta.url),
      'utf8'
    )
    assert.match(
      transportSource,
      /const renewal = renewTelegramPollLease\([\s\S]*?\)\s*\n\s*if \(!renewal\.renewed\) {\s*\n\s*continue\s*\n\s*}\s*\n\s*for \(const update of updates\)/,
      'poll loop must skip processing when lease renewal fails'
    )

    console.log('telegram poll lease regression checks passed')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

void run()
