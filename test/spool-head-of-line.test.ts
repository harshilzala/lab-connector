import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpoolQueue } from '../src/queue/spool.js';
import { HmisUnavailableError } from '../src/hmis/client.js';

// =============================================================================
// One unfilable item must not hold the queue.
//
// WHY. The drain used to end its pass on ANY failure, on the theory that a
// failure meant the gateway was down. Most failures are not that: "no order
// rows matched barcode G2905" is a control run under a made-up id, and it took
// 50 attempts × 15 s = 12½ minutes to park — during which every patient
// result queued behind it waited. 2026-09-19, VITROS 250: R0000005 (G2905)
// arrived 10:04 IST and SF2609190018/29/16 + SF2609180021 filed at 10:15,
// 7–8 minutes after they were received. Same day, ECiQ: SF2609180018 (no
// thyroid rows anywhere in HMIS) sat at the head while six results behind it
// with perfectly good rows were never attempted.
//
// Pinned here:
//   • an item-level failure retries that item and CONTINUES to the next,
//   • a gateway failure (holdQueue) still ends the pass — nothing behind it
//     is attempted until the next tick.
//
//   npx tsx test/spool-head-of-line.test.ts
// =============================================================================

const G = '\x1b[32m✓\x1b[0m';
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
const settle = () => new Promise<void>((r) => setTimeout(r, 50));

console.log('\n[1] An item nobody can file does not block the items behind it');
{
  const dir = mkdtempSync(join(tmpdir(), 'spool-hol-'));
  const q = new SpoolQueue<{ barcode: string }>(dir, quiet);
  q.enqueue({ barcode: 'G2905' }, '1-control');
  q.enqueue({ barcode: 'SF2609190018' }, '2-patient');
  q.enqueue({ barcode: 'SF2609190029' }, '3-patient');
  const delivered: string[] = [];
  q.start(async (p) => {
    if (p.barcode === 'G2905') throw new Error(`no order rows matched barcode ${p.barcode} — nothing to file`);
    delivered.push(p.barcode);
  }, 60_000);
  await settle();
  q.stop();
  assert.deepEqual(delivered, ['SF2609190018', 'SF2609190029'], `expected both patients filed, got ${delivered.join(',')}`);
  console.log(`  ${G} both patient results filed in the same pass: ${delivered.join(', ')}`);
  const pending = q.listPending();
  assert.deepEqual(pending.map((e) => [e.id, e.attempts]), [['1-control', 1]]);
  console.log(`  ${G} the control stays queued for its own retry (attempts=1), nothing else pending`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n[2] A gateway outage still ends the pass — nothing behind it is tried');
{
  const dir = mkdtempSync(join(tmpdir(), 'spool-hol-'));
  const q = new SpoolQueue<{ barcode: string }>(dir, quiet);
  q.enqueue({ barcode: 'SF2609190014' }, '1-first');
  q.enqueue({ barcode: 'SF2609190017' }, '2-second');
  let attempted = 0;
  q.start(async () => {
    attempted++;
    throw new HmisUnavailableError('HMIS POST /mirth/labresult -> timed out after 15000ms');
  }, 60_000);
  await settle();
  q.stop();
  assert.equal(attempted, 1, `expected exactly one attempt, got ${attempted}`);
  console.log(`  ${G} one attempt, then the pass stopped`);
  assert.deepEqual(q.listPending().map((e) => [e.id, e.attempts]), [['1-first', 1], ['2-second', 0]]);
  console.log(`  ${G} the second item was not touched (attempts=0)`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n[3] HmisUnavailableError is what holds the queue; a plain Error is not');
{
  assert.equal(new HmisUnavailableError('x').holdQueue, true);
  assert.equal((new Error('x') as { holdQueue?: unknown }).holdQueue, undefined);
  console.log(`  ${G} marker present only on the gateway error`);
}

console.log('\nALL SPOOL HEAD-OF-LINE TESTS PASSED\n');
