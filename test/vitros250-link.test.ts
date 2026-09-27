import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { KermitLink, KermitRejectedError } from '../src/codec/kermit/link.js';
import { KermitDecoder, DEFAULT_PARAMS, encodePacket, type KermitPacket } from '../src/codec/kermit/packets.js';
import type { Transport } from '../src/transport/types.js';

// =============================================================================
// VITROS 250 — link behaviour the Ortho spec (Part No. 355283, ch. 5) and the
// site's own wire evidence require. See the header of src/codec/kermit/link.ts.
//
//   [1] NAK ZERO solicitations are never answered, and are surfaced.
//   [2] A download waits for an upload that has only got as far as S / F.
//   [3] Two S packets crossing: the host keeps waiting for its Y (§5.6.7).
//   [4] E 0000 / 0002 come back typed as "busy", not as a broken link.
//   [5] A late duplicate Y does not trigger a retransmit.
//   [6] Our send-init carries our parameters.
//
//   npx tsx test/vitros250-link.test.ts
// =============================================================================

const G = '\x1b[32m✓\x1b[0m';
const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as never;
const tick = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A scriptable VITROS: records what the host sends, replies as told. */
class FakeVitros extends EventEmitter implements Transport {
  readonly kind = 'tcp' as const;
  readonly connected = true;
  readonly describe = 'tcp://fake-vitros';
  readonly received: KermitPacket[] = [];
  private readonly decoder = new KermitDecoder();
  /** Decide the reply to a host packet; return null to stay silent. */
  reply: (p: KermitPacket) => KermitPacket | null = (p) => ({
    seq: p.seq,
    type: 'Y',
    data: p.type === 'S' ? '~* @-#N1' : '',
  });

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async write(data: Buffer): Promise<void> {
    for (const { packet } of this.decoder.push(data)) {
      this.received.push(packet);
      // Acknowledgements are not themselves acknowledged.
      if (packet.type === 'Y' || packet.type === 'N' || packet.type === 'E') continue;
      const r = this.reply(packet);
      if (r) setImmediate(() => this.send(r));
    }
  }
  /** Analyzer → host. */
  send(p: KermitPacket): void {
    this.emit('data', encodePacket(p, DEFAULT_PARAMS));
  }
  types(): string {
    return this.received.map((p) => p.type).join('');
  }
}

const order = (sampleId: string) => ({
  sampleId,
  testCodes: ['76'],
  priority: 'R' as const,
  patient: null,
  specimenType: null,
});

const makeLink = (t: FakeVitros, extra: Partial<ConstructorParameters<typeof KermitLink>[1]> = {}) =>
  new KermitLink(t, {
    ackTimeoutMs: 300,
    maxRetries: 3,
    interPacketDelayMs: 0,
    interTransferDelayMs: 0,
    receiveStallMs: 200,
    logger: quiet,
    ...extra,
  });

// A one-file upload as the analyzer sends it: S F D Z B, with a real result
// record from the site's wire log.
const RESULT = '1751030911               ZC2609110093   10#41.000)  134.   000}(    4.08 000}|5275      ]';
const upload = (t: FakeVitros, delayMs = 0) =>
  (async () => {
    const packets: KermitPacket[] = [
      { seq: 0, type: 'S', data: '~* @-#N1' },
      { seq: 1, type: 'F', data: 'R0001703' },
      { seq: 2, type: 'D', data: RESULT.replace(/#/g, '##') },
      { seq: 3, type: 'Z', data: '' },
      { seq: 4, type: 'B', data: '' },
    ];
    for (const p of packets) {
      t.send(p);
      await sleep(delayMs);
      await tick();
    }
  })();

// ---- [1] NAK ZERO ----------------------------------------------------------
console.log('\n[1] NAK ZERO — idle N(0) packets are noted and never answered');
{
  const t = new FakeVitros();
  const link = makeLink(t);
  let solicits = 0;
  link.on('solicit', () => solicits++);
  await link.start();

  // Three idle solicitations, as the analyzer sends them once a minute. The
  // second one used to draw a Y(0) from the duplicate-ACK path.
  for (let i = 0; i < 3; i++) {
    t.send({ seq: 0, type: 'N', data: '' });
    await tick();
  }
  assert.equal(t.received.length, 0, `host must stay silent on N(0), sent: ${t.types()}`);
  assert.equal(solicits, 3, `each N(0) surfaces as a solicit event, got ${solicits}`);
  assert.ok(link.lastSolicitAt > 0);
  console.log(`  ${G} three N(0) → nothing on the wire, ${solicits} solicit events`);

  // ...and the download that follows is a clean S F D Z B.
  await link.sendOrders([order('ZC2609110001')]);
  assert.equal(t.types(), 'SFDZB', `got ${t.types()}`);
  console.log(`  ${G} the download after them: ${t.types()}`);
  await link.stop();
}

// ---- [2] download waits for an upload that has only sent S ----------------
console.log('\n[2] An upload is "in progress" from its S, not from its first D');
{
  const t = new FakeVitros();
  const link = makeLink(t);
  const messages: unknown[] = [];
  link.on('message', (m) => messages.push(m));
  await link.start();

  // The analyzer opens an upload; we acknowledge its S. Nothing else yet.
  t.send({ seq: 0, type: 'S', data: '~* @-#N1' });
  await tick();
  assert.equal(t.types(), 'Y', `expected only our Y to its S, got ${t.types()}`);
  assert.equal(t.received[0]!.data, '~* @-#N1', 'the Y to a send-init carries our parameters');
  assert.ok(link.receiving, 'link must count the upload as in progress from S');

  // Now the orchestrator wants to download. This used to go out at once —
  // straight into the analyzer's established session — because rxData was
  // still empty. It must wait.
  const download = link.sendOrders([order('ZC2609110002')]);
  await sleep(30);
  assert.equal(t.types(), 'Y', `download must not start during an upload, wire: ${t.types()}`);

  // The analyzer finishes its file; the download then goes.
  for (const p of [
    { seq: 1, type: 'F', data: 'R0001703' },
    { seq: 2, type: 'D', data: RESULT.replace(/#/g, '##') },
    { seq: 3, type: 'Z', data: '' },
    { seq: 4, type: 'B', data: '' },
  ] as KermitPacket[]) {
    t.send(p);
    await tick();
  }
  await download;
  assert.equal(t.types(), 'YYYYYSFDZB', `upload fully acked, then the download: ${t.types()}`);
  assert.equal(messages.length, 1, 'the result file was parsed');
  assert.ok(!link.receiving);
  console.log(`  ${G} wire order: ${t.types()} — result file received, then our transfer`);
  await link.stop();
}

// ---- [2b] a stalled upload cannot hold downloads forever --------------------
console.log('\n[2b] An upload that goes silent is abandoned after receiveStallMs');
{
  const t = new FakeVitros();
  const link = makeLink(t, { receiveStallMs: 100 });
  await link.start();
  t.send({ seq: 0, type: 'S', data: '~* @-#N1' });
  t.send({ seq: 1, type: 'F', data: 'R0001704' });
  await tick();
  const started = Date.now();
  await link.sendOrders([order('ZC2609110003')]);
  const waited = Date.now() - started;
  assert.ok(waited >= 90 && waited < 1000, `should wait ~receiveStallMs then proceed, waited ${waited}ms`);
  assert.equal(t.types(), 'YYSFDZB', `got ${t.types()}`);
  console.log(`  ${G} download went after ${waited}ms of analyzer silence`);
  await link.stop();
}

// ---- [3] crossed send-inits ------------------------------------------------
console.log('\n[3] Crossed S packets — the analyzer yields (§5.6.7), the host keeps waiting');
{
  const t = new FakeVitros();
  const link = makeLink(t);
  await link.start();
  // On our S the fake first sends ITS OWN S (they crossed), then — as the
  // spec says the analyzer does — abandons its upload and acknowledges ours.
  t.reply = (p) => {
    if (p.type === 'S') {
      t.send({ seq: 0, type: 'S', data: '~* @-#N1' });
      return { seq: 0, type: 'Y', data: '~* @-#N1' };
    }
    return { seq: p.seq, type: 'Y', data: '' };
  };
  await link.sendOrders([order('ZC2609110004')]);
  assert.equal(t.types(), 'SFDZB', `one clean transfer expected, got ${t.types()}`);
  console.log(`  ${G} its S ignored, our transfer completed: ${t.types()}`);
  await link.stop();
}

// ---- [4] busy / disabled ---------------------------------------------------
console.log('\n[4] E 0000 / 0002 are typed as busy; other codes are not');
{
  for (const [code, busy] of [
    ['0000 RECEIVER BUSY', true],
    ['0002 RECEIVER DISABLED', true],
    ['0005 INVALID PACKET USAGE', false],
  ] as const) {
    const t = new FakeVitros();
    const link = makeLink(t);
    await link.start();
    t.reply = (p) => ({ seq: p.seq, type: 'E', data: code });
    await assert.rejects(link.sendOrders([order('ZC2609110005')]), (err: unknown) => {
      assert.ok(err instanceof KermitRejectedError, 'typed error');
      assert.equal(err.code, code.slice(0, 4));
      assert.equal(err.busy, busy, `${code} busy=${busy}`);
      return true;
    });
    console.log(`  ${G} E ${code.padEnd(26)} → code ${code.slice(0, 4)}, busy=${busy}`);
    await link.stop();
  }
}

// ---- [5] a late duplicate Y ------------------------------------------------
console.log('\n[5] A late duplicate Y for the previous packet does not cause a retransmit');
{
  const t = new FakeVitros();
  const link = makeLink(t);
  await link.start();
  // Acknowledge F twice — the second copy lands while we wait for the Y to D.
  t.reply = (p) => {
    if (p.type === 'F') setImmediate(() => t.send({ seq: p.seq, type: 'Y', data: '' }));
    return { seq: p.seq, type: 'Y', data: p.type === 'S' ? '~* @-#N1' : '' };
  };
  await link.sendOrders([order('ZC2609110006')]);
  assert.equal(t.types(), 'SFDZB', `no packet may be sent twice, got ${t.types()}`);
  console.log(`  ${G} ${t.types()} — the duplicate Y(1) was waited out`);
  await link.stop();
}

// ---- [6] our send-init carries parameters ---------------------------------
console.log('\n[6] Our S announces our parameters (TIME 10) instead of "wait forever"');
{
  const t = new FakeVitros();
  const link = makeLink(t);
  await link.start();
  await link.sendOrders([order('ZC2609110007')]);
  assert.equal(t.received[0]!.type, 'S');
  assert.equal(t.received[0]!.data, '~* @-#N1', `got ${JSON.stringify(t.received[0]!.data)}`);
  console.log(`  ${G} S data = ${JSON.stringify(t.received[0]!.data)}`);
  await link.stop();
}

console.log('\nALL VITROS 250 LINK TESTS PASSED\n');
