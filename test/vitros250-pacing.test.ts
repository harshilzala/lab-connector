import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { KermitLink } from '../src/codec/kermit/link.js';
import { KermitDecoder, DEFAULT_PARAMS, encodePacket } from '../src/codec/kermit/packets.js';
import { buildOrderRecord } from '../src/codec/kermit/vitros250.js';
import type { Transport } from '../src/transport/types.js';

// =============================================================================
// VITROS 250 — packet pacing and the patient-name field.
//
// WHY THIS EXISTS. The legacy Vitros250.exe paced every Kermit packet by one
// second (VitrosDelayTime=1000) and, across the whole captured production run,
// the analyzer never answered with an error packet. This connector sent the
// same bytes with no pause at all — a whole transfer in about 0.8 s, the next
// send-init immediately after — and on 2026-09-07 the analyzer rejected 160 of
// 1177 transfers:
//
//     0005 INVALID PACKET USAGE   x125
//     0008 INVALID SEQUENCE USE   x35
//
// 151 of those 160 arrived within two seconds of the previous transfer
// finishing. Every rejection failed the download, tripped the order-download
// breaker, and had the same order re-sent minutes later (LB2609070198 went out
// seven times in 23 minutes).
//
// So the contract pinned here is that the link paces itself like the host the
// analyzer has accepted for years, and that a single-name patient reaches the
// wire the way the legacy host wrote it.
//
//   npx tsx test/vitros250-pacing.test.ts
// =============================================================================

const G = '\x1b[32m✓\x1b[0m';
const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as never;

/** A VITROS that acknowledges every packet immediately, and records when. */
class FakeVitros extends EventEmitter implements Transport {
  readonly kind = 'tcp' as const;
  readonly connected = true;
  readonly describe = 'tcp://fake-vitros';
  /** ms since the harness started, one entry per packet we received. */
  readonly arrivals: Array<{ at: number; type: string }> = [];
  private readonly decoder = new KermitDecoder();
  private readonly t0 = Date.now();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async write(data: Buffer): Promise<void> {
    for (const { packet } of this.decoder.push(data)) {
      this.arrivals.push({ at: Date.now() - this.t0, type: packet.type });
      // Answer as the analyzer does: Y on the same sequence. The send-init's
      // acknowledgement carries the analyzer's parameters.
      const reply = { seq: packet.seq, type: 'Y' as const, data: packet.type === 'S' ? '~* @-#N1' : '' };
      setImmediate(() => this.emit('data', encodePacket(reply, DEFAULT_PARAMS)));
    }
  }
}

const order = (sampleId: string, codes: number[], patient: Record<string, unknown> | null) => ({
  sampleId,
  testCodes: codes.map(String),
  priority: 'R' as const,
  patient: patient as never,
  specimenType: null,
});

// ---- 1) packets are paced, and consecutive transfers are separated ---------
console.log('\n[1] Pacing — one order, then a second right behind it');

const PACE = 120; // scaled down from the production 1000ms so the test is quick
const transport = new FakeVitros();
const link = new KermitLink(transport, {
  ackTimeoutMs: 5000,
  maxRetries: 5,
  interPacketDelayMs: PACE,
  interTransferDelayMs: PACE,
  logger: quiet,
});
await link.start();

await link.sendOrders([
  order('ZC2609070001', [76, 90, 46], { lastName: 'SONI', firstName: 'MAHESHBHAI', middleName: null }),
]);
const firstTransfer = transport.arrivals.length;
await link.sendOrders([order('ZC2609070002', [32], { lastName: 'VERMA', firstName: 'SUMAN', middleName: null })]);

const types = transport.arrivals.map((a) => a.type).join('');
assert.equal(types, 'SFDZBSFDZB', `expected two full transfers, got ${types}`);
console.log(`  ${G} two transfers, packets in order: ${types}`);

// Every gap after the first packet must respect the pause. The S of the second
// transfer is additionally held by the inter-transfer delay.
const gaps = transport.arrivals.slice(1).map((a, i) => a.at - transport.arrivals[i]!.at);
const tooFast = gaps.filter((g) => g < PACE * 0.8);
assert.equal(tooFast.length, 0, `every packet must be paced by ~${PACE}ms, saw gaps: ${gaps.join(', ')}`);
console.log(`  ${G} all ${gaps.length} inter-packet gaps >= ${Math.round(PACE * 0.8)}ms  [${gaps.join(', ')}]`);

const gapBetweenTransfers = transport.arrivals[firstTransfer]!.at - transport.arrivals[firstTransfer - 1]!.at;
assert.ok(gapBetweenTransfers >= PACE * 0.8, `transfers must not run together: ${gapBetweenTransfers}ms`);
console.log(`  ${G} gap between the B of one transfer and the S of the next: ${gapBetweenTransfers}ms`);
await link.stop();

// ---- 2) pacing is optional, so tests and simulators stay fast --------------
console.log('\n[2] interPacketDelayMs: 0 sends without pausing');
const fast = new FakeVitros();
const fastLink = new KermitLink(fast, {
  ackTimeoutMs: 5000,
  maxRetries: 5,
  interPacketDelayMs: 0,
  interTransferDelayMs: 0,
  logger: quiet,
});
await fastLink.start();
const started = Date.now();
await fastLink.sendOrders([order('ZC2609070003', [76], null)]);
const elapsed = Date.now() - started;
assert.ok(elapsed < PACE, `unpaced transfer should be immediate, took ${elapsed}ms`);
console.log(`  ${G} five packets in ${elapsed}ms with pacing off`);
await fastLink.stop();

// ---- 3) the patient-name field ---------------------------------------------
console.log('\n[3] Patient name — a lone "." is not part of the name');

// HMIS sends LName "." for a single-name patient. The legacy host, reading one
// Name column, wrote "DEEPSHIKHA"; this connector wrote ".DEEPSHIKHA" on 102
// of 1177 orders.
const single = buildOrderRecord(
  order('LB2609070198', [32], { lastName: '.', firstName: 'DEEP SHIKHA', middleName: null }),
);
assert.equal(single, '   LB260907019810 1.000 |               DEEPSHIKHA]', `got ${JSON.stringify(single)}`);
console.log(`  ${G} lone "." dropped: ${JSON.stringify(single.slice(-26))}`);

// A dot INSIDE a real name is untouched — the legacy corpus contains
// "KAPILKUMAR." and the corpus replay pins it.
const dotted = buildOrderRecord(order('SF2608310026', [76], { lastName: 'KAPILKUMAR.', firstName: null, middleName: null }));
assert.ok(dotted.includes('KAPILKUMAR.]'), `a dot inside a name must survive: ${dotted}`);
console.log(`  ${G} "KAPILKUMAR." kept intact`);

// Ordinary two-part names are unchanged.
const normal = buildOrderRecord(order('SF2608310028', [76, 51, 102, 49, 59, 90, 46], { lastName: 'SUMAN', firstName: 'VERMA', middleName: null }));
assert.equal(normal, '   SF260831002810 1.000L3f1;Z.|               SUMANVERMA]');
console.log(`  ${G} ordinary names byte-identical to the captured order`);

console.log('\nALL VITROS 250 PACING TESTS PASSED\n');
