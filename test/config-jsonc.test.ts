import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseJsonc } from '../src/config.js';

// Self-test for the JSONC config loader.
//
// config.json carries a commented-out alternative transport beside the live one
// (COM port vs Moxa serial-device server on TCP), so the loader must accept
// comments — and the parked sample must stay VALID, or it is worse than useless
// the day someone switches the cabling back.
//   Run:  npx tsx test/config-jsonc.test.ts

// ---- 1) comment stripping is string-aware ---------------------------------
{
  const doc = parseJsonc(`{
  // a line comment
  "url": "https://example.com/live/portal", // must survive: it contains //
  "note": "a /* not-a-comment */ inside a string, and a trailing , too",
  /* a block
     comment spanning lines */
  "port": 4001,
  "list": [1, 2, 3,],
  "obj": { "a": 1, },
}`) as Record<string, unknown>;

  assert.equal(doc.url, 'https://example.com/live/portal', 'the // in a URL is data, not a comment');
  assert.equal(doc.note, 'a /* not-a-comment */ inside a string, and a trailing , too');
  assert.equal(doc.port, 4001);
  assert.deepEqual(doc.list, [1, 2, 3], 'trailing comma in an array');
  assert.deepEqual(doc.obj, { a: 1 }, 'trailing comma in an object');
  assert.equal(Object.keys(doc).length, 5, 'comments contributed no keys');
}

// An escaped quote must not be mistaken for the end of the string.
assert.deepEqual(parseJsonc('{"a":"say \\" // not a comment","b":1}'), { a: 'say " // not a comment', b: 1 });

// Line numbers stay honest: comments are blanked out, never removed, so a
// syntax error still names the line the editor shows.
try {
  parseJsonc('{\n  // one\n  /* two */\n  oops: 1\n}');
  assert.fail('expected a syntax error');
} catch (err) {
  assert.match((err as Error).message, /line 4/, 'error points at the real line');
}
console.log('✓ JSONC: comments, trailing commas, strings and line numbers');

// ---- 2) the real config still loads ---------------------------------------
const cfg = loadConfig('./config.json');
console.log(`✓ config.json loads: ${cfg.analyzers.map((a) => `${a.id}(${a.protocol})`).join(', ')}`);

// ---- 3) every PARKED transport sample is valid config ---------------------
// Pull each commented-out "transport" block out of the file, uncomment it, and
// push it through the real schema. A stale sample fails here rather than at 2am
// when someone moves a machine back onto its COM port.
const text = readFileSync('./config.json', 'utf8');
const lines = text.split(/\r?\n/);
const parked: string[] = [];
let run: string[] = [];

// A run of commented lines may open with prose explaining the sample; the JSON
// starts at the `"transport"` key.
const collect = (r: string[]) => {
  const start = r.findIndex((l) => l.trimStart().startsWith('"transport"'));
  if (start !== -1) parked.push(r.slice(start).join('\n'));
};

for (const line of lines) {
  const m = /^\s*\/\/\s?(.*)$/.exec(line);
  if (m) {
    run.push(m[1]!);
    continue;
  }
  if (run.length) {
    collect(run);
    run = [];
  }
}
if (run.length) collect(run);

if (parked.length === 0) console.log('– no parked transport sample in config.json (nothing to verify)');

const dir = mkdtempSync(join(tmpdir(), 'lab-connector-cfg-'));
for (const [i, block] of parked.entries()) {
  // The block is `"transport": { … },` — wrap it into an object to parse it.
  const { transport } = parseJsonc(`{${block.replace(/,\s*$/, '')}}`) as { transport: unknown };
  const probe = {
    ...cfg,
    analyzers: [{ id: 'parked-sample', equipmentCode: 'PROBE', protocol: 'astm', transport }],
  };
  const file = join(dir, `parked-${i}.json`);
  writeFileSync(file, JSON.stringify(probe, null, 2));
  const loaded = loadConfig(file);
  const t = loaded.analyzers[0]!.transport;
  assert.equal(t.type, 'serial', 'the parked sample is the COM-mode alternative');
  console.log(
    `✓ parked sample ${i + 1} valid: serial://${t.path}@${t.baudRate} ` +
      `${t.dataBits}-${t.parity[0]!.toUpperCase()}-${t.stopBits} dtr=${t.dtr} rts=${t.rts}`,
  );
}

// The COM ports and line settings the legacy middleware ran on
// (E:\API_Integration\Devices\{ECiQ,250}\*.exe.config: ComVal, .NET SerialPort
// defaults of 9600 8-N-1). A sample that drifts from these is not a sample.
const ports = parked.map((b) => /"path"\s*:\s*"([^"]+)"/.exec(b)?.[1]).filter(Boolean);
for (const port of ports) {
  assert.ok(['COM2', 'COM3'].includes(port!), `${port} is not a COM port the reference config used`);
}
if (ports.length) console.log(`✓ parked ports match the legacy reference: ${ports.join(', ')}`);

console.log('\nALL CONFIG JSONC TESTS PASSED');
