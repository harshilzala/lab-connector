import assert from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResultStore } from '../src/results/store.js';
import type { HmisResultUpload } from '../src/types.js';

// =============================================================================
// A staged result file that will not parse must be SEEN, not skipped.
//
// Found on the Prahlad Nagar BC-5150, 23 Sep 2026: seven files in
// spool/zhp-bc5150/results, each 8 KB of NUL bytes, each stamped 20 Sep 13:05
// — an unclean shutdown losing the data blocks of files written just before
// it. (The writer is sound: it writes a temp file and renames.) The store read
// them, caught the parse error, returned null, and said nothing; the samples
// were simply absent from every count the console showed. That time nothing
// was lost to HMIS — all five real barcodes had already filed — but the log
// could not have told anyone either way.
//
// Pinned here: the file is moved to results/corrupt/, named in a warning, and
// counted out of the store exactly once; healthy samples beside it are
// untouched and a later pass does not warn again.
//
//   npx tsx test/staged-corrupt.test.ts
// =============================================================================

const G = '\x1b[32m✓\x1b[0m';

const warnings: Array<{ file?: string; reason?: string; msg: string }> = [];
const log = {
  child: () => log,
  info() {},
  debug() {},
  trace() {},
  fatal() {},
  error() {},
  warn(o: unknown, m?: string) {
    if (typeof o === 'object' && o && typeof m === 'string') warnings.push({ ...(o as object), msg: m } as never);
  },
} as never;

const dir = mkdtempSync(join(tmpdir(), 'lab-staged-corrupt-'));
const store = new ResultStore(dir, log);

const upload = (barcode: string): HmisResultUpload => ({
  barcode,
  eqCode: 'ZHPN001',
  equipmentId: null,
  isQc: false,
  results: [
    { sampleId: barcode, testCode: 'WBC', value: '8.9', unit: null, referenceRange: null, abnormalFlag: null, status: 'F', completedAt: null, instrument: null },
    { sampleId: barcode, testCode: 'HGB', value: '13.1', unit: null, referenceRange: null, abnormalFlag: null, status: 'F', completedAt: null, instrument: null },
  ],
});

console.log('\n[1] A healthy sample, then the BC-5150\'s all-NUL file beside it');
store.upsert(upload('PL2609230023'));
// Byte for byte what was found: an 8 KB run of NULs where JSON should be.
writeFileSync(join(dir, 'PL2609190030.json'), Buffer.alloc(8498));
assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 2);
console.log(`  ${G} two files on disk, one of them unreadable`);

console.log('\n[2] Listing the store quarantines it, names it, and keeps the healthy one');
{
  const listed = store.list();
  assert.deepEqual(listed.map((s) => s.barcode), ['PL2609230023'], 'the healthy sample still lists');
  const hit = warnings.find((w) => w.msg.startsWith('staged results for this sample could not be read'));
  assert.ok(hit, `expected the quarantine warning, got ${JSON.stringify(warnings.map((w) => w.msg))}`);
  assert.equal(hit!.file, 'PL2609190030.json');
  console.log(`  ${G} warned: ${hit!.msg}`);
  console.log(`  ${G} file: ${hit!.file} — reason: ${hit!.reason}`);

  assert.ok(!existsSync(join(dir, 'PL2609190030.json')), 'the bad file must have been moved out of the sample directory');
  const quarantined = readdirSync(join(dir, 'corrupt'));
  assert.equal(quarantined.length, 1, `expected one quarantined file, got ${JSON.stringify(quarantined)}`);
  assert.ok(quarantined[0]!.startsWith('PL2609190030.json.'), quarantined[0]);
  console.log(`  ${G} moved to corrupt/${quarantined[0]} — still on disk to look at`);
}

console.log('\n[3] It is not warned about again, and corrupt/ is never walked as samples');
{
  warnings.length = 0;
  const listed = store.list();
  assert.deepEqual(listed.map((s) => s.barcode), ['PL2609230023']);
  assert.deepEqual(warnings, [], `a second pass must be silent, got ${JSON.stringify(warnings)}`);
  console.log(`  ${G} second pass: one sample listed, nothing warned`);
}

console.log('\n[4] A file that parses but is not a staged sample goes the same way');
{
  warnings.length = 0;
  writeFileSync(join(dir, 'PL2609190044.json'), '{"not":"a staged sample"}', 'utf8');
  store.list();
  const hit = warnings.find((w) => w.file === 'PL2609190044.json');
  assert.ok(hit, `expected it quarantined too, got ${JSON.stringify(warnings)}`);
  assert.equal(readdirSync(join(dir, 'corrupt')).length, 2);
  console.log(`  ${G} ${hit!.reason}`);
}

rmSync(dir, { recursive: true, force: true });
console.log('\nstaged-corrupt: all checks passed\n');
