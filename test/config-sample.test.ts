import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseJsonc } from '../src/config.js';
import {
  extractCommentedAnalyzers,
  isSecretKey,
  mergeSource,
  readLibrary,
  redact,
  renderSample,
  scanConfigText,
  type Library,
} from '../scripts/make-config-sample.js';

// Self-test for the config library generator (scripts/make-config-sample.ts).
//   Run:  npx tsx test/config-sample.test.ts

// ---- 1) secrets never survive ------------------------------------------------
{
  for (const k of ['password', 'clientSecret', 'apiKey', 'token', 'HMAC_SECRET', 'privateKey', 'pwd']) {
    assert.ok(isSecretKey(k), `${k} is a secret`);
  }
  for (const k of ['tokenPath', 'revokePath', 'apiKeyHeader', 'authFile', 'barcodeField', 'timeoutMs']) {
    assert.ok(!isSecretKey(k), `${k} names where a secret goes, not the secret`);
  }

  const out = redact({
    Force_Hmis: { password: 'Force' },
    autoCertify: { oracle: { user: 'zylive', password: 'ZYLive26', connectString: 'scott/tiger@10.0.0.1:1521/orcl' } },
    hmis: {
      baseUrl: 'http://admin:pw@98.70.1.180:8050/live/portal',
      genx: { clientId: 'cid', clientSecret: 'shh', apiKey: 'k', apiKeyHeader: 'X-API-Key', tokenPath: '/oauth/token' },
    },
    admin: { user: 'admin-ui' }, // no secret beside it: an ordinary setting, kept
  }) as any;
  assert.equal(out.Force_Hmis.password, '');
  assert.equal(out.autoCertify.oracle.password, '');
  assert.equal(out.autoCertify.oracle.user, '', 'the user beside a password goes too');
  assert.equal(out.autoCertify.oracle.connectString, '10.0.0.1:1521/orcl', 'user/pass@ cut from the connect string');
  assert.equal(out.hmis.baseUrl, 'http://98.70.1.180:8050/live/portal', 'user:pass@ cut from the URL');
  assert.equal(out.hmis.genx.clientSecret, '');
  assert.equal(out.hmis.genx.clientId, '');
  assert.equal(out.hmis.genx.apiKey, '');
  assert.equal(out.hmis.genx.apiKeyHeader, 'X-API-Key');
  assert.equal(out.hmis.genx.tokenPath, '/oauth/token');
  assert.equal(out.admin.user, 'admin-ui');
}

// ---- 2) parked analyzer blocks are found ------------------------------------
{
  const text = `{
  "analyzers": [
    { "id": "live-one", "equipmentCode": "A1", "transport": { "type": "tcp", "port": 1 } }
    // ------------------------------------------------------------
    // Prose with a { brace and "quotes" that is not a block.
    // Alternative transport:
    //   "transport": { "type": "serial", "path": "COM3" }
    // ------------------------------------------------------------
    // ,
    // {
    //   "id": "parked",
    //   // inner comment survives one level of uncommenting
    //   "equipmentCode": "P1",

    //   "transport": { "type": "tcp", "mode": "client", "host": "10.0.0.9", "port": 4001 }
    // }
  ]
}`;
  const parked = extractCommentedAnalyzers(text);
  assert.equal(parked.length, 1);
  assert.equal(parked[0]!.id, 'parked');
  assert.deepEqual(parked[0]!.transport, { type: 'tcp', mode: 'client', host: '10.0.0.9', port: 4001 });

  const scan = scanConfigText(text)!;
  assert.deepEqual(scan.live.map((a) => a.id), ['live-one']);
  assert.equal(scanConfigText('{ "compilerOptions": {} }'), null, 'not a lab-connector config');
}

// ---- 3) the library is cumulative --------------------------------------------
{
  const lib: Library = { settings: {}, analyzers: {} };
  const cfg = (port: number, more = '') =>
    scanConfigText(`{ "logLevel": "info", "analyzers": [ { "id": "m", "equipmentCode": "E", "transport": { "type": "tcp", "port": ${port} } } ${more} ] }`)!;

  mergeSource(lib, 'a/config.json', cfg(1, ', { "id": "gone", "equipmentCode": "G", "transport": { "type": "tcp", "port": 9 } }'));
  mergeSource(lib, 'b/config.json', cfg(1));
  assert.equal(lib.analyzers.m!.length, 1, 'identical blocks are stored once');
  assert.deepEqual(lib.analyzers.m![0]!.from, ['a/config.json', 'b/config.json']);

  // a/ is edited: port changes, "gone" is deleted.
  mergeSource(lib, 'a/config.json', cfg(2));
  assert.equal(lib.analyzers.m!.length, 2, 'the edit is a new variant; b/ still has the old one');
  assert.deepEqual(lib.analyzers.m!.find((v) => (v.value as any).transport.port === 1)!.from, ['b/config.json']);
  assert.deepEqual(lib.analyzers.gone![0]!.from, ['a/config.json [removed]'], 'a deleted machine is kept');

  // Round trip through the rendered file: re-reading and re-writing is stable.
  const text = renderSample(lib);
  assert.equal(renderSample(readLibrary(text)), text);
}

// ---- 4) every block in the real config.sample.json still loads ---------------
const samplePath = new URL('../config.sample.json', import.meta.url);
if (existsSync(samplePath)) {
  const sample = readFileSync(samplePath, 'utf8');
  assert.doesNotMatch(sample, /ZYLive|"password":\s*"[^"]/, 'no password value in the sample');
  const lib = readLibrary(sample);
  const dir = mkdtempSync(join(tmpdir(), 'cfg-sample-'));
  const file = join(dir, 'config.json');
  let checked = 0;
  for (const [id, variants] of Object.entries(lib.analyzers)) {
    for (const v of variants) {
      writeFileSync(file, JSON.stringify({ hmis: { baseUrl: 'http://127.0.0.1:9' }, analyzers: [v.value] }));
      assert.doesNotThrow(() => loadConfig(file), `analyzer "${id}" from ${v.from.join(', ')} loads`);
      checked++;
    }
  }
  console.log(`  ${checked} library block(s) load cleanly`);
  assert.ok(parseJsonc(sample));
}

console.log('config-sample: all checks passed');
