import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrderStore } from '../src/orders/store.js';
import { groupPendingByBarcode, mergePending, normalizePending } from '../src/hmis/pending.js';
import type { MirthAcknowledgeItem, PendingOrders } from '../src/types.js';

// Pins the order store's download bookkeeping — the thing that makes proactive
// polling safe to repeat every 30s against rows that are never acknowledged
// until their result is filed:
//   • the first sighting of a tube offers every test
//   • re-polling the same rows offers nothing
//   • a test added later is offered on its own
//   • a re-ordered test (new labResultId) is offered again
//   • rows survive for result-time lookup after HMIS stops returning them
//   Run:  npx tsx test/order-store.test.ts

const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as any;
const dir = mkdtempSync(join(tmpdir(), 'lab-orders-'));

function row(identifier: string, labResultId: number): MirthAcknowledgeItem {
  return {
    sampleID: 'SF2609050001',
    equipmentId: 177335561,
    identifier,
    ipAddress: '10.20.1.54',
    isTransmitted: true,
    labResultId,
    labServiceId: 4703,
    portNo: '4001',
    parameterId: null,
  };
}
function pending(rows: MirthAcknowledgeItem[]): PendingOrders {
  return {
    found: rows.length > 0,
    sampleId: 'SF2609050001',
    testCodes: rows.map((r) => r.identifier),
    patient: { patientId: '10002025543290', firstName: 'SHOBHIT', lastName: 'BEHERA', middleName: null, sex: 'M', birthDate: '20170703' },
    priority: 'R',
    specimenType: 'Serum',
    ackItems: rows,
  };
}

try {
  const store = new OrderStore(dir, quiet);

  // first sighting → everything is new
  let r = store.upsert('sf2609050001', pending([row('1.000000+035+1', 1), row('1.000000+032+1', 2)]), 'poll');
  assert.deepStrictEqual(r.newCodes, ['1.000000+035+1', '1.000000+032+1']);
  assert.strictEqual(r.order.barcode, 'SF2609050001', 'key is canonical');
  assert.strictEqual(r.order.sampleId, 'SF2609050001', 'sampleId as HMIS spelled it');
  store.markDownloaded('SF2609050001', r.newCodes);

  // same rows again → nothing to push
  r = store.upsert('SF2609050001', pending([row('1.000000+035+1', 1), row('1.000000+032+1', 2)]), 'poll');
  assert.deepStrictEqual(r.newCodes, [], 're-poll is idempotent');

  // a test added to the order → only that one
  r = store.upsert('SF2609050001', pending([row('1.000000+035+1', 1), row('1.000000+032+1', 2), row('1.000000+074+1', 3)]), 'poll');
  assert.deepStrictEqual(r.newCodes, ['1.000000+074+1']);
  store.markDownloaded('SF2609050001', r.newCodes);

  // re-order of an existing test (new labResultId) → offered again, old row replaced
  r = store.upsert('SF2609050001', pending([row('1.000000+035+1', 99)]), 'poll');
  assert.deepStrictEqual(r.newCodes, ['1.000000+035+1']);
  assert.strictEqual(r.order.rows.find((x) => x.identifier === '1.000000+035+1')!.labResultId, 99);
  assert.strictEqual(r.order.rows.length, 3, 'other rows kept');

  // the store answers result-time lookups without HMIS
  const fresh = new OrderStore(dir, quiet); // a "restart"
  const got = fresh.get('sf2609050001 ');
  assert.ok(got && got.rows.length === 3, 'rows survive on disk');
  assert.strictEqual(got!.patient?.firstName, 'SHOBHIT');
  assert.strictEqual(fresh.count(), 1);

  // sweep keeps recent entries and drops stale ones
  assert.strictEqual(fresh.sweep(30), 0);
  assert.strictEqual(fresh.sweep(0, Date.now() + 1000), 1);
  assert.strictEqual(fresh.count(), 0);

  // ---- multi-sample poll reply → one order per barcode ----------------------
  const body = {
    data: [
      { SampleID: 'SF2609050009', equipmentCode: 'ZHFC01', eqIdntifier: '1.000000+032+1', labResultId: 10, labServiceId: 4700, equipmentId: 177335561, ipAddress: '10.20.1.54', portNo: '4001', FName: 'RAJVEER', LName: 'SUCHAK', Gender: 1, DOB: '20110613', specimenName: 'Serum' },
      { SampleID: 'SF2609050009', equipmentCode: 'ZHFC01', eqIdntifier: '1.000000+035+1', labResultId: 11, labServiceId: 4703, equipmentId: 177335561, ipAddress: '10.20.1.54', portNo: '4001' },
      { SampleID: 'SF2609050017', equipmentCode: 'ZHFC01', eqIdntifier: '1.000000+009+1', labResultId: 12, labServiceId: 4711, equipmentId: 177335561, ipAddress: '10.20.1.54', portNo: '4001' },
      { SampleID: 'SF2609050099', equipmentCode: 'ZHFC02', eqIdntifier: '32', labResultId: 13, labServiceId: 13, equipmentId: 177336856, ipAddress: '10.20.1.53', portNo: '4001' },
    ],
    status: 'success',
  };
  const groups = groupPendingByBarcode(body, { eqCode: 'ZHFC01' });
  assert.deepStrictEqual([...groups.keys()], ['SF2609050009', 'SF2609050017'], 'other code filtered out, grouped by tube');
  assert.deepStrictEqual(groups.get('SF2609050009')!.testCodes, ['1.000000+032+1', '1.000000+035+1']);
  assert.strictEqual(groups.get('SF2609050009')!.patient?.lastName, 'SUCHAK');

  // ---- one tube, tests under two codes → one merged order --------------------
  const psa = normalizePending(
    [{ SampleID: 'SF2609050009', equipmentCode: 'ZYCAPIFC01', eqIdntifier: '1.000000+075+1', labResultId: 20, labServiceId: 4761, equipmentId: 222778829, ipAddress: '10.20.1.54', portNo: '4001', specimenName: 'Serum' }],
    { sampleId: 'SF2609050009', eqCode: 'ZYCAPIFC01' },
  );
  const merged = mergePending([groups.get('SF2609050009')!, psa]);
  assert.deepStrictEqual(merged.testCodes, ['1.000000+032+1', '1.000000+035+1', '1.000000+075+1']);
  assert.strictEqual(merged.ackItems.length, 3);
  assert.strictEqual(merged.ackItems[2]!.equipmentId, 222778829, 'each row keeps the equipmentId it was raised under');
  assert.ok(merged.found);
  const none = mergePending([normalizePending([], { sampleId: 'X', eqCode: 'A' }), normalizePending([], { sampleId: 'X', eqCode: 'B' })]);
  assert.strictEqual(none.found, false);

  // ---- a colliding file name must never return another tube's rows ---------
  // safeSpoolId folds the characters Windows rejects, so "AB/CD" and "AB_CD"
  // share one file. Handing back the neighbour's entry would file this sample's
  // results against another sample's labResultIds.
  {
    const collide = new OrderStore(dir, quiet);
    collide.upsert('AB_CD', pending([row('X1', 900)]), 'poll');
    const other = collide.get('AB/CD');
    assert.strictEqual(other, null, 'a folded-name neighbour is not returned as this barcode');
    assert.strictEqual(collide.get('AB_CD')?.rows[0]?.labResultId, 900, 'the real barcode still reads back');
    console.log('order-store: colliding file names do not cross tubes');
  }

  // ---- count() is cached but stays truthful --------------------------------
  // It is read by /api/status on every 5s dashboard poll, so it must not scan
  // the directory each time — and must still track additions and sweeps.
  {
    const counted = new OrderStore(dir, quiet);
    const before = counted.count();
    counted.upsert('CNT-1', pending([row('Y1', 901)]), 'poll');
    assert.strictEqual(counted.count(), before + 1, 'a new barcode moves the count');
    counted.upsert('CNT-1', pending([row('Y1', 901)]), 'poll');
    assert.strictEqual(counted.count(), before + 1, 're-writing an existing barcode does not');
    assert.strictEqual(counted.sweep(0, Date.now() + 86_400_000) > 0, true, 'sweep removes aged entries');
    assert.strictEqual(counted.count(), 0, 'the count re-derives after a sweep');
    console.log('order-store: count() cache tracks adds and sweeps');
  }

  console.log('order-store: OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
