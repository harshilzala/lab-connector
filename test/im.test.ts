// =============================================================================
// IM — auto-certification of analyzer results before they reach Mirth.
//
// What the lab relies on, pinned here against a fake Mirth:
//
//   1. a value inside its reference range files straight away, marked
//      certified (isCertified / isAutoCertified / certifiedBy = IM-AUTO)
//   2. a value outside the range, flagged by the analyzer, non-numeric, or
//      with no range at all is HELD — nothing about it reaches Mirth, and its
//      pending row is not acknowledged
//   3. a held value is not re-offered by the next filing pass
//   4. verifying files it as certified BY THAT PERSON and retires its row
//   5. rejecting never files it
//   6. a verify whose post fails keeps the value verified-but-unsent, and the
//      next verify sends it
//   7. a rerun that comes back in range supersedes the held value
//   8. the range comes from IM config first, then Mirth, then the analyzer
//   9. an analyzer with IM switched off files exactly as before
//  10. the queue (non-staged) path gates the same way
//  11. every step lands in the per-order transaction log
//
// Run: npx tsx test/im.test.ts   (npm run im)
// =============================================================================
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, imGateFor, type AppConfig } from '../src/config.js';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import { ImTracker } from '../src/im/tracker.js';
import { DEFAULT_GATE_CONFIG, judge, parseRangeText, resolveRange } from '../src/im/gate.js';
import { normalizePending } from '../src/hmis/pending.js';
import type { HmisClient } from '../src/hmis/client.js';
import type { ParsedMessage } from '../src/types.js';

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};
const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, level: 'silent' } as any;

// ---------------------------------------------------------------------------
console.log('\n— ranges and verdicts');
{
  const r = (t: string) => JSON.stringify(parseRangeText(t));
  check(r('3.5 - 5.5') === '{"low":3.5,"high":5.5}', 'parses "3.5 - 5.5"');
  check(r('70-110') === '{"low":70,"high":110}', 'parses "70-110"');
  check(r('5.5^7.2') === '{"low":5.5,"high":7.2}', 'parses the ASTM "5.5^7.2" form');
  check(r('< 200') === '{"low":null,"high":200}', 'parses "< 200" as an upper bound');
  check(r('>40') === '{"low":40,"high":null}', 'parses ">40" as a lower bound');
  check(parseRangeText('Negative') === null, 'a word is not a range');
  check(parseRangeText('9 - 3') === null, 'an inverted range is refused, not guessed');

  const cfg = { ...DEFAULT_GATE_CONFIG, enabled: true, ranges: { GLU: { low: 70, high: 110, criticalHigh: 400 } } };
  const v = (value: string, extra: object = {}) => judge(cfg, { testCode: 'GLU', value, ...extra }, undefined);
  check(v('95').decision === 'certify', 'in range → certify');
  const hi = v('150');
  check(hi.decision === 'hold' && hi.reason === 'out-of-range', 'above range → hold (out-of-range)');
  const crit = v('450');
  check(crit.decision === 'hold' && crit.reason === 'critical', 'past the critical limit → hold (critical)');
  const flagged = v('95', { abnormalFlag: 'H' });
  check(flagged.decision === 'hold' && flagged.reason === 'analyzer-flag', 'in range but flagged H by the analyzer → hold');
  check(v('95', { abnormalFlag: 'N' }).decision === 'certify', 'flag N is normal');
  const prelim = v('95', { status: 'P' });
  check(prelim.decision === 'hold' && prelim.reason === 'not-final', 'preliminary result → hold');
  const lt = v('<0.02');
  check(lt.decision === 'hold' && lt.reason === 'not-numeric', 'a "<0.02" value is not treated as a plain number');

  const none = judge(cfg, { testCode: 'NA', value: '140' }, undefined);
  check(none.decision === 'hold' && none.reason === 'no-range', 'no range anywhere → hold (no-range)');
  check(judge({ ...cfg, holdWhenNoRange: false }, { testCode: 'NA', value: '140' }, undefined).decision === 'certify',
    'holdWhenNoRange=false lets an unranged number file');
  check(judge(cfg, { testCode: 'HIV', value: 'Non Reactive' }, undefined).decision === 'certify', 'a listed normal word certifies');
  check(judge(cfg, { testCode: 'HIV', value: 'Reactive' }, undefined).decision === 'hold', 'any other word is held');
  check(judge({ ...cfg, alwaysReview: ['glu'] }, { testCode: 'GLU', value: '95' }, undefined).decision === 'hold',
    'alwaysReview holds even an in-range value (case-insensitive)');

  const mirthRow = { identifier: 'GLU', refLow: 60, refHigh: 100 } as any;
  check(resolveRange(cfg, 'GLU', mirthRow, '10-20')!.source === 'config', 'IM config range wins over Mirth and the analyzer');
  const noCfg = { ...cfg, ranges: {} };
  check(resolveRange(noCfg, 'GLU', mirthRow, '10-20')!.source === 'mirth', 'Mirth range wins over the analyzer');
  check(resolveRange(noCfg, 'GLU', { identifier: 'GLU', refText: '0.6 - 1.2' } as any, null)!.high === 1.2, "Mirth's text range is parsed");
  check(resolveRange(noCfg, 'GLU', { identifier: 'GLU' } as any, '10-20')!.source === 'analyzer', "the analyzer's range is the last resort");

  const parsed = normalizePending(
    [{ SampleID: 'X1', eqIdntifier: 'GLU', labResultId: 5, minValue: '70', maxValue: '110', criticalHigh: 400, normalRange: '70 - 110' }],
    { sampleId: 'X1' },
  );
  const it = parsed.ackItems[0]!;
  check(it.refLow === 70 && it.refHigh === 110 && it.criticalHigh === 400 && it.refText === '70 - 110',
    'range columns on a Mirth pending row are read (minValue/maxValue/criticalHigh/normalRange)');
}

// ---------------------------------------------------------------------------
// A fake Mirth: pending rows per barcode, a record of every post.
const dir = mkdtempSync(join(tmpdir(), 'im-'));
const pending = new Map<string, unknown[]>();
const posted: Array<Record<string, unknown>> = [];
const acked: Array<Record<string, unknown>> = [];
let failNextPost = false;
const mirthRow = (sampleId: string, code: string, labResultId: number, extra: object = {}) => ({
  SampleID: sampleId, eqIdntifier: code, equipmentCode: 'IMTEST', equipmentId: 42, labResultId,
  labServiceId: 7000 + labResultId, parameterId: labResultId, ipAddress: '10.0.0.9', portNo: '5000', ...extra,
});
const hmis = {
  defaultSiteIds: [undefined],
  siteId: null,
  async getPending(q: { sampleId: string }) {
    return { status: 'success', data: q.sampleId ? pending.get(q.sampleId) ?? [] : [] };
  },
  async acknowledge(items: Array<Record<string, unknown>>) {
    acked.push(...items);
  },
  async postResults(rows: Array<Record<string, unknown>>) {
    if (failNextPost) {
      failNextPost = false;
      throw new Error('Mirth channel stopped');
    }
    posted.push(...rows);
    return { status: 'success', message: 'saved', successData: rows, filed: rows.length };
  },
} as unknown as HmisClient;

function appConfig(filing: 'staged' | 'queue', port: number, imOn = true): AppConfig {
  const path = join(dir, `config-${filing}-${port}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      hmis: { baseUrl: 'http://mirth.test/api', auditLog: null },
      spoolDir: join(dir, 'spool'),
      retention: { logDir: join(dir, 'logs') },
      im: {
        enabled: true,
        gate: { ranges: { K: { low: 3.5, high: 5.1 } } },
      },
      analyzers: [
        {
          id: `im-${filing}-${port}`,
          equipmentCode: 'IMTEST',
          equipmentId: 42,
          protocol: 'hl7',
          hostQuery: false,
          transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port },
          filing: { mode: filing },
          im: { enabled: imOn },
        },
      ],
    }),
  );
  return loadConfig(path);
}

function runtime(app: AppConfig) {
  const a = app.analyzers[0]!;
  const tracker = new ImTracker(a.id, imGateFor(app, a), app.im.mirth.fields, app.im.mirth.autoCertifiedBy, join(dir, 'spool'), join(dir, 'logs'), quiet);
  const rt = new AnalyzerRuntime(a, hmis, join(dir, 'spool'), quiet, undefined, 7, { im: tracker });
  const inner = rt as unknown as { onMessage(m: ParsedMessage): Promise<void>; filer: { running: boolean; run(r: string, only?: string): Promise<unknown> } };
  // onMessage starts a filing pass of its own without awaiting it; a pass
  // asked for while one runs is skipped. So: wait for the background pass,
  // then run one we can await.
  const file = async (barcode: string) => {
    for (let i = 0; i < 200 && inner.filer.running; i++) await new Promise((r) => setTimeout(r, 5));
    await inner.filer.run('test', barcode);
  };
  return { rt, tracker, inner, file };
}

const message = (sampleId: string, values: Array<[string, string, string?, string?]>): ParsedMessage => ({
  protocol: 'hl7',
  queries: [],
  results: values.map(([testCode, value, abnormalFlag, referenceRange]) => ({ sampleId, testCode, value, abnormalFlag, referenceRange })),
  raw: 'MSH|...',
});

async function staged() {
  console.log('\n— staged analyzer, IM on');
  const app = appConfig('staged', 47811);
  const { rt, tracker, inner, file } = runtime(app);

  pending.set('LB1', [
    mirthRow('LB1', 'GLU', 1, { minValue: 70, maxValue: 110 }), // Mirth range
    mirthRow('LB1', 'CREA', 2, { referenceRange: '0.6 - 1.2' }), // Mirth text range
    mirthRow('LB1', 'K', 3), // IM config range 3.5 - 5.1
    mirthRow('LB1', 'NA', 4), // no range anywhere
    mirthRow('LB1', 'ALT', 5), // analyzer range only
  ]);
  await inner.onMessage(message('LB1', [['GLU', '95'], ['CREA', '2.5', 'H'], ['K', '4.0'], ['NA', '140'], ['ALT', '30', 'N', '0-40']]));
  await file('LB1');

  const sent = posted.map((r) => r.identifier).sort().join(',');
  check(sent === 'ALT,GLU,K', `in-range values filed at once (got ${sent})`);
  check(posted.every((r) => r.isCertified === true && r.isAutoCertified === true && r.certifiedBy === 'IM-AUTO'),
    'filed rows carry isCertified / isAutoCertified / certifiedBy=IM-AUTO');
  check(posted.find((r) => r.identifier === 'K')?.referenceRange === '3.5 - 5.1', 'the range judged by is sent with the row');
  check(acked.map((r) => r.identifier).sort().join(',') === 'ALT,GLU,K', 'only the filed rows are acknowledged — held rows stay pending in Mirth');

  const review = tracker.reviewList();
  check(review.length === 1 && review[0]!.pending === 2, 'CREA and NA are on the action-required list');
  check(review[0]!.worst === 'analyzer-flag' || review[0]!.worst === 'out-of-range', `worst reason ranks first (${review[0]!.worst})`);
  const staged = rt.stagedSummaries()!.find((s) => s.barcode === 'LB1')!;
  check(staged.review === 2 && staged.waiting === 0, 'the staged store shows them as under review, not waiting for an order');

  posted.length = 0;
  await file('LB1');
  check(posted.length === 0, 'a second filing pass does not re-offer held values');

  // Verify, but Mirth fails the first time.
  failNextPost = true;
  let threw = false;
  try {
    await rt.imVerify('LB1', ['CREA'], 'Dr A Shah (admin)', 'repeat matches');
  } catch {
    threw = true;
  }
  const afterFail = tracker.reviewSample('LB1')!.items.find((i) => i.testCode === 'CREA')!;
  check(threw && afterFail.state === 'verified' && afterFail.filedAt === null && !!afterFail.lastError,
    'a failed verify keeps the value verified-but-unsent with the error');
  const retry = await rt.imVerify('LB1', [], 'Dr A Shah (admin)', null);
  const crea = posted.find((r) => r.identifier === 'CREA');
  check(retry!.sent === 1 && !!crea, 'the next verify sends it');
  check(crea?.isAutoCertified === false && crea?.certifiedBy === 'Dr A Shah (admin)' && crea?.remarks === 'repeat matches' && crea?.isAbnormal === true,
    'a verified row is certified by the person, with their comment, marked abnormal');
  check(acked.some((r) => r.identifier === 'CREA'), 'its pending row is acknowledged after filing');
  check(rt.stagedSummaries()!.find((s) => s.barcode === 'LB1')!.values.find((v) => v.testCode === 'CREA')!.state === 'filed',
    'the staged store marks it filed');

  posted.length = 0;
  const n = rt.imReject('LB1', ['NA'], 'Dr A Shah (admin)', 'haemolysed');
  check(n === 1 && posted.length === 0 && !acked.some((r) => r.identifier === 'NA'), 'rejecting files nothing and acknowledges nothing');

  const kinds = new Set(tracker.history('LB1').map((t) => t.kind));
  for (const k of ['order-received', 'result-received', 'certified', 'held', 'filed', 'acknowledged', 'file-failed', 'verified', 'rejected']) {
    check(kinds.has(k as never), `transaction log has "${k}"`);
  }
  const order = tracker.orders().find((o) => o.barcode === 'LB1')!;
  check(order.status === 'completed' && order.verified === 1 && order.rejected === 1, `order summary is completed (${order.status})`);

  // Rerun: a held value comes back in range → superseded, filed.
  console.log('\n— rerun supersedes a held value');
  pending.set('LB2', [mirthRow('LB2', 'GLU', 11, { minValue: 70, maxValue: 110 })]);
  await inner.onMessage(message('LB2', [['GLU', '300']]));
  await file('LB2');
  check(tracker.reviewSample('LB2')!.pending === 1, 'GLU 300 is held');
  posted.length = 0;
  await inner.onMessage(message('LB2', [['GLU', '98']]));
  await file('LB2');
  check(posted.length === 1 && posted[0]!.resultValue === '98', 'the in-range rerun files');
  const sup = tracker.reviewSample('LB2')!;
  check(sup.pending === 0 && sup.items[0]!.state === 'rejected' && sup.items[0]!.decidedBy === 'IM', 'the stale held value is superseded, not left on the list');

  // The console preview matches what the gate would do.
  const pv = rt.mirthPreview('LB1')!;
  check(pv.verdicts.length === 5 && pv.rows.every((r) => (r as Record<string, unknown>).isCertified === true), 'preview shows verdicts and certified rows without sending');
}

async function imOff() {
  console.log('\n— analyzer with IM switched off');
  const app = appConfig('staged', 47812, false);
  const { tracker, inner, file } = runtime(app);
  check(!tracker.enabled, 'gate disabled for this analyzer');
  pending.set('LB3', [mirthRow('LB3', 'GLU', 21, { minValue: 70, maxValue: 110 })]);
  posted.length = 0;
  await inner.onMessage(message('LB3', [['GLU', '300']]));
  await file('LB3');
  check(posted.length === 1 && posted[0]!.isCertified === undefined, 'an out-of-range value files as before, no certification columns');
  check(tracker.reviewList().length === 0, 'nothing is held');
  check(tracker.history('LB3').some((t) => t.kind === 'filed'), 'the order is still tracked on the IM dashboard');
}

async function queue() {
  console.log('\n— queue analyzer, IM on');
  const app = appConfig('queue', 47813);
  const { rt, tracker, inner } = runtime(app);
  pending.set('LB4', [mirthRow('LB4', 'GLU', 31, { minValue: 70, maxValue: 110 }), mirthRow('LB4', 'CREA', 32, { referenceRange: '0.6 - 1.2' })]);
  posted.length = 0;
  await rt.start();
  try {
    await inner.onMessage(message('LB4', [['GLU', '90'], ['CREA', '3.1']]));
    for (let i = 0; i < 50 && rt.spoolPending().length + posted.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    check(posted.length === 1 && posted[0]!.identifier === 'GLU' && posted[0]!.isCertified === true, 'the in-range value is filed, certified');
    check(tracker.reviewSample('LB4')?.pending === 1, 'the out-of-range value is held for review');
    check(rt.spoolPending().length === 0 && rt.spoolFailed().length === 0, 'the spool item is done — the review list holds the rest');
  } finally {
    await rt.stop();
  }
}

try {
  await staged();
  await imOff();
  await queue();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
