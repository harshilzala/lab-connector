import { EventEmitter } from 'node:events';
import assert from 'node:assert';
import { parseRollerFrame, rollerChecksum, frameRoller } from '../src/codec/roller/parser.js';
import { RollerLink, type RollerLinkOptions } from '../src/codec/roller/link.js';
import { PROFILE_LIBRARY } from '../src/profiles/index.js';
import type { ParsedMessage } from '../src/types.js';
import { logger } from '../src/logger.js';

// Self-test for the Alifax ROLLER 20LC codec, against the examples printed in
// the Technical Manual rev 1.3, pp. 79–82.
//   Run:  npx tsx test/roller.test.ts

const ID = (s: string) => s.padEnd(15, ' ');

// ---- 1) checksum rule matches the manual's examples --------------------------
{
  assert.equal(rollerChecksum('R01LATEX08451005  0101010002'), 0x19);
  assert.equal(rollerChecksum('R01LATEX08452036  0102010034'), 0x1c);
  assert.equal(rollerChecksum('R01LATEX08453083  0103010071'), 0x13);
  assert.equal(String.fromCharCode(rollerChecksum(`R01${ID('123456789')}0103050012`)), 'f');
  assert.equal(String.fromCharCode(rollerChecksum(`Q01${ID('123456789')}0000`)), 'a');
  assert.equal(String.fromCharCode(rollerChecksum(`T01${ID('123456789')}0001`)), 'e');
  assert.equal(String.fromCharCode(rollerChecksum(`T01${ID('123456789')}0000`)), 'd');
  console.log('✓ checksum agrees with the manual');
}

// ---- 2) parser ----------------------------------------------------------------
{
  const r = parseRollerFrame(`R01${ID('123456789')}0103050012f`);
  assert.ok(r.checksumOk);
  assert.equal(r.message?.kind, 'result');
  const m = r.message as Extract<typeof r.message, { kind: 'result' }>;
  assert.equal(m.sampleId, '123456789');
  assert.equal(m.rack, '01');
  assert.equal(m.position, '03');
  assert.equal(m.value, '12');
  assert.equal(m.outcome, 'value');
  assert.equal(m.isQc, false);

  const err = parseRollerFrame(`R01${ID('123456789')}010305-004` + String.fromCharCode(rollerChecksum(`R01${ID('123456789')}010305-004`)));
  assert.equal((err.message as { outcome: string }).outcome, 'error');

  const low = `R01${ID('LB2611120001')}010305*015`;
  const lowP = parseRollerFrame(low + String.fromCharCode(rollerChecksum(low)));
  assert.equal((lowP.message as { outcome: string }).outcome, 'low-hematocrit');
  assert.equal((lowP.message as { value: string }).value, '15');

  const latex = parseRollerFrame('R01LATEX08451005  0101010002\x19');
  assert.ok(latex.checksumOk);
  assert.equal((latex.message as { isQc: boolean }).isQc, true);

  const dat08 = 'R01AB123456010203' + '0045';
  const d = parseRollerFrame(dat08 + String.fromCharCode(rollerChecksum(dat08)));
  assert.equal((d.message as { format: string }).format, 'DAT08');
  assert.equal((d.message as { value: string }).value, '45');

  const q = parseRollerFrame(`Q01${ID('123456789')}0000a`);
  assert.deepEqual(q.message, { kind: 'query', workstation: '01', sampleId: '123456789' });

  assert.equal(parseRollerFrame(`R01${ID('123456789')}0103050012X`).checksumOk, false);
  assert.equal(parseRollerFrame('R0112345').message, null);
  console.log('✓ parser: value, error, low-Hct, latex QC, DAT08, query, bad checksum, bad length');
}

// ---- 3) link: framing across chunks, ACK, query reply, filing rules ----------
class FakeTransport extends EventEmitter {
  readonly kind = 'tcp' as const;
  readonly describe = 'fake://roller';
  connected = true;
  writes: Buffer[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async write(d: Buffer): Promise<void> {
    this.writes.push(d);
  }
  feed(s: string | Buffer): void {
    this.emit('data', typeof s === 'string' ? Buffer.from(s, 'latin1') : s);
  }
}

const tick = () => new Promise((r) => setImmediate(r));

async function run(opts: Partial<RollerLinkOptions> = {}) {
  const t = new FakeTransport();
  const link = new RollerLink(t as never, {
    logger,
    verifyChecksum: true,
    ack: true,
    answerQueries: true,
    fileLowHematocrit: false,
    ...opts,
  });
  const got: ParsedMessage[] = [];
  link.on('message', (m: ParsedMessage) => got.push(m));
  await link.start();
  return { t, got };
}

{
  const { t, got } = await run();
  const good = frameRoller(`R01${ID('LB2611120001')}0103050012`);
  t.feed('noise');
  t.feed(good.subarray(0, 10));
  t.feed(good.subarray(10));
  await tick();
  assert.equal(got.length, 1);
  assert.equal(got[0]!.protocol, 'alifax-roller');
  assert.deepEqual(
    { id: got[0]!.results[0]!.sampleId, code: got[0]!.results[0]!.testCode, v: got[0]!.results[0]!.value, u: got[0]!.results[0]!.unit },
    { id: 'LB2611120001', code: 'ESR', v: '12', u: 'mm/h' },
  );
  assert.deepEqual([...t.writes[0]!], [0x06], 'ACK after R');

  t.feed(frameRoller(`Q01${ID('LB2611120002')}0000`));
  await tick();
  assert.deepEqual(t.writes[1], frameRoller(`T01${ID('LB2611120002')}0001`), 'query answered T…0001 (run)');

  t.feed(frameRoller(`R01${ID('LB2611120003')}010305-004`)); // instrument error
  t.feed(frameRoller(`R01${ID('LB2611120004')}010305*015`)); // low Hct, not filed by default
  t.feed(`\x02R01${ID('LB2611120005')}0103050012X\x03`); // bad checksum
  await tick();
  assert.equal(got.length, 1, 'error, low-Hct and bad-checksum frames are not filed');

  t.feed(Buffer.from('\x02R01LATEX08451005  0101010002\x19\x03', 'latin1'));
  await tick();
  assert.equal(got.length, 2);
  assert.equal(got[1]!.isQc, true, 'latex run is QC');
  console.log('✓ link: chunked framing, ACK, query answered "run", errors/low-Hct/bad checksum held, latex QC');
}
{
  const { t, got } = await run({ fileLowHematocrit: true });
  t.feed(frameRoller(`R01${ID('LB2611120004')}010305*015`));
  await tick();
  assert.equal(got.length, 1);
  assert.equal(got[0]!.results[0]!.value, '15');
  assert.equal(got[0]!.results[0]!.abnormalFlag, 'A');
  console.log('✓ fileLowHematocrit honoured');
}

// ---- 3b) short id → barcode (legacy Middleware rule) --------------------------
{
  // Real frame from the legacy log, 2026-10-29: "0354" was filed as HE2610290354.
  const { t, got } = await run({ shortIdPrefix: 'HE', now: () => new Date(2026, 9, 29, 15, 28, 18) });
  t.feed(frameRoller(`R01${ID('0354')}0103050012`));
  t.feed(frameRoller(`R01${ID('HE2611130100')}0103050020`)); // a full barcode stays as is
  t.feed(Buffer.from('\x02R01LATEX08451005  0101010002\x19\x03', 'latin1')); // QC stays as is
  await tick();
  assert.deepEqual(got.map((m) => m.results[0]!.sampleId), ['HE2610290354', 'HE2611130100', 'LATEX08451005']);

  const plain = await run();
  plain.t.feed(frameRoller(`R01${ID('0354')}0103050012`));
  await tick();
  assert.equal(plain.got[0]!.results[0]!.sampleId, '0354', 'no prefix configured → id as sent');
  console.log('✓ shortIdPrefix: 0354 on 2026-10-29 → HE2610290354; full barcodes and QC untouched');
}

// ---- 4) profile ---------------------------------------------------------------
{
  const p = PROFILE_LIBRARY['alifax-roller20lc'].defaults as Record<string, any>;
  assert.equal(p.protocol, 'alifax-roller');
  assert.equal(p.transport.mode, 'client', 'connector dials the NPort');
  assert.equal(p.hostQuery, false);
  assert.equal(p.orderPoll.download, false);
  assert.deepEqual(p.allowTestCodes, ['ESR']);
  assert.ok(p.qc.sampleIdPrefixes.includes('LATEX'));
  console.log('✓ profile alifax-roller20lc');
}

console.log('roller: all checks passed');
