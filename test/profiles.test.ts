import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { PROFILE_LIBRARY, PROFILE_NAMES, applyProfile } from '../src/profiles/index.js';

// Machine profiles: a block that names a profile gets that model's defaults
// underneath it, and everything the block says wins.
//   Run:  npx tsx test/profiles.test.ts

const dir = mkdtempSync(join(tmpdir(), 'lab-connector-profiles-'));
function writeConfig(name: string, analyzers: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({ hmis: { baseUrl: 'https://hmis.example.test/portal' }, analyzers }, null, 2),
    'utf8',
  );
  return path;
}

// ---- 1) merge semantics ----------------------------------------------------
{
  const merged = applyProfile({
    id: 'x',
    profile: 'mindray-bc5150',
    equipmentCode: 'ZHPN001',
    transport: { host: '10.20.4.50' },
    allowTestCodes: ['WBC'],
  }) as Record<string, any>;
  assert.equal(merged.protocol, 'hl7', 'scalar from profile');
  assert.deepEqual(merged.transport, { type: 'tcp', mode: 'client', port: 5100, host: '10.20.4.50' }, 'objects merge one level');
  assert.deepEqual(merged.allowTestCodes, ['WBC'], 'arrays replace, never union');
  assert.equal(merged.hl7.charset, 'UNICODE');
  assert.equal(merged.equipmentCode, 'ZHPN001');

  const untouched = { id: 'y', protocol: 'astm' };
  assert.strictEqual(applyProfile(untouched), untouched, 'no profile → same object back');

  const bad = { id: 'z', profile: 'no-such-model' };
  assert.strictEqual(applyProfile(bad), bad, 'unknown profile left for the schema to reject');
  console.log('✓ merge: block wins, objects merge, arrays replace');
}

// ---- 2) the minimal second-site block loads and is complete ---------------
{
  const path = writeConfig('site-b.json', [
    { id: 'site-b-bc5150', profile: 'mindray-bc5150', equipmentCode: 'ZHPN002', transport: { host: '10.30.1.7' } },
  ]);
  const cfg = loadConfig(path);
  const a = cfg.analyzers[0]!;
  assert.equal(a.protocol, 'hl7');
  assert.equal(a.transport.type, 'tcp');
  assert.equal(a.transport.mode, 'client');
  assert.equal(a.transport.host, '10.30.1.7');
  assert.equal((a.transport as any).port, 5100, 'port from the profile');
  assert.equal(a.hostQuery, false);
  assert.equal(a.orderPoll.enabled, true);
  assert.equal(a.orderPoll.download, false);
  assert.equal(a.filing.mode, 'staged');
  assert.equal(a.fillMissingOrderRows, true);
  assert.ok(a.allowTestCodes.includes('MID%') && a.allowTestCodes.includes('NEU%'), 'both 3-part and 5-part mnemonics');
  assert.ok(a.ignoreTestCodes.includes('*Histogram*'));
  assert.equal(a.hl7.valueTypes[0], 'NM');
  assert.equal(a.qc.sampleIdPrefixes[0], 'QC');
  console.log('✓ second site: id + profile + equipmentCode + host is a complete analyzer');
}

// ---- 3) site overrides win, including a nested transport key --------------
{
  const path = writeConfig('site-c.json', [
    {
      id: 'site-c-bc5150',
      profile: 'mindray-bc5150',
      equipmentCode: 'ZHPN003',
      transport: { host: '10.40.1.7', port: 5200 },
      orderPoll: { intervalMs: 20000 },
      testCodeAliases: { HGB: 'HAEMOGLOBIN' },
    },
  ]);
  const a = loadConfig(path).analyzers[0]!;
  assert.equal((a.transport as any).port, 5200, 'site port overrides the profile port');
  assert.equal(a.transport.mode, 'client', 'profile mode kept');
  assert.equal(a.orderPoll.intervalMs, 20000, 'site cadence');
  assert.equal(a.orderPoll.download, false, 'profile default kept beside the override');
  assert.deepEqual(a.testCodeAliases, { HGB: 'HAEMOGLOBIN' }, 'site-specific HMIS spelling');
  console.log('✓ overrides: nested keys replace one at a time');
}

// ---- 4) a mistyped profile is a config error naming the valid ones --------
{
  const path = writeConfig('bad.json', [{ id: 'bad', profile: 'mindray-bc515', equipmentCode: 'X', transport: { host: '1.2.3.4' } }]);
  assert.throws(() => loadConfig(path), (e: Error) => /profile/.test(e.message) && /mindray-bc5150/.test(e.message));
  console.log('✓ unknown profile rejected with the list of valid names');
}

// ---- 5) the library itself ------------------------------------------------
{
  assert.ok(PROFILE_NAMES.length >= 3);
  for (const name of PROFILE_NAMES) {
    const p = PROFILE_LIBRARY[name];
    assert.ok(p.description.length > 10, `${name} has a description`);
    assert.ok(typeof p.defaults.protocol === 'string', `${name} names its protocol`);
    const t = p.defaults.transport as Record<string, unknown> | undefined;
    assert.ok(t && t.type, `${name} names its transport type`);
    // A profile must never carry site identity.
    for (const k of ['id', 'equipmentCode', 'extraEquipmentCodes', 'siteId', 'machineId', 'testCodeAliases']) {
      assert.ok(!(k in p.defaults), `${name} must not set ${k}`);
    }
    if (t.mode === 'client') assert.ok(!('host' in t), `${name}: a dialled analyzer's host is site-specific`);
  }
  assert.strictEqual(PROFILE_LIBRARY['mindray-bc5000'], PROFILE_LIBRARY['mindray-bc5150'], 'BC-5000 shares the BC-5150 profile');
  assert.strictEqual(PROFILE_LIBRARY['vitros-eci'], PROFILE_LIBRARY['vitros-eciq'], 'ECi shares the ECiQ profile');
  // A profile must not name a site's barcode prefix: that allow-list drops
  // every result that does not match, so it belongs to the block alone.
  for (const name of PROFILE_NAMES) {
    const qc = PROFILE_LIBRARY[name].defaults.qc as Record<string, unknown> | undefined;
    assert.ok(!qc || !('patientPrefixes' in qc), `${name} must not set qc.patientPrefixes`);
    const poll = PROFILE_LIBRARY[name].defaults.orderPoll as Record<string, unknown> | undefined;
    assert.ok(!poll || !('downloadPrefixes' in poll), `${name} must not set orderPoll.downloadPrefixes`);
  }
  console.log(`✓ library: ${PROFILE_NAMES.join(', ')}`);
}

// ---- 6) VITROS ECiQ: NPort site block, and the direct-COM alternative -----
{
  const path = writeConfig('vitros-eciq.json', [
    // Behind a Moxa NPort in TCP Server mode: host and port are the site's.
    { id: 'site-eciq', profile: 'vitros-eciq', equipmentCode: 'ZCCEQ001', transport: { host: '10.12.19.42', port: 4002 },
      qc: { patientPrefixes: ['ZC'] } },
    // Cabled straight to COM1: the serial block replaces the tcp one.
    { id: 'site-eciq-com', profile: 'vitros-eciq', equipmentCode: 'ZCCEQ002', transport: { type: 'serial', path: 'COM1' } },
  ]);
  const [a, b] = loadConfig(path).analyzers;
  assert.equal(a!.protocol, 'astm');
  assert.deepEqual(a!.transport, { type: 'tcp', mode: 'client', host: '10.12.19.42', port: 4002 });
  assert.equal(a!.astm.dialect, 'vitros-eciq');
  assert.equal(a!.astm.senderId, 'HOST');
  assert.equal(a!.astm.receiverId, '');
  assert.equal(a!.astm.ackTimeoutMs, 15000);
  assert.equal(a!.sendDemographics, true);
  assert.equal(a!.hostQuery, false);
  assert.equal(a!.orderPoll.enabled, true);
  assert.equal(a!.orderPoll.download, true);
  assert.deepEqual(a!.qc.patientPrefixes, ['ZC'], 'site barcode prefix from the block');
  assert.ok(a!.qc.sampleIdPrefixes.includes('$'), 'profile QC deny-list kept beside it');
  assert.equal(b!.transport.type, 'serial');
  assert.equal((b!.transport as any).path, 'COM1');
  assert.equal((b!.transport as any).baudRate, 9600);
  assert.ok(!('mode' in b!.transport), 'tcp-only key from the profile is dropped on a serial transport');
  console.log('✓ vitros-eciq: NPort block and COM block both load');

  // Without the NPort port the block is incomplete — the port is site wiring,
  // and the schema must say so rather than dial a guessed one.
  const bad = writeConfig('vitros-eciq-noport.json', [
    { id: 'site-eciq', profile: 'vitros-eciq', equipmentCode: 'X', transport: { host: '10.12.19.42' } },
  ]);
  assert.throws(() => loadConfig(bad), /port/);
  console.log('✓ vitros-eciq: a missing NPort port is a config error');
}

// ---- 7) VITROS 250: Kermit with the load-bearing pacing ------------------
{
  const path = writeConfig('vitros-250.json', [
    { id: 'site-v250', profile: 'vitros-250', equipmentCode: 'ZCCEQ003', transport: { host: '10.12.19.41', port: 4001 },
      qc: { patientPrefixes: ['ZC'] }, orderPoll: { downloadPrefixes: ['ZC'] } },
  ]);
  const a = loadConfig(path).analyzers[0]!;
  assert.equal(a.protocol, 'kermit');
  assert.deepEqual(a.transport, { type: 'tcp', mode: 'client', host: '10.12.19.41', port: 4001 });
  assert.equal(a.kermit.interPacketDelayMs, 1000);
  assert.equal(a.kermit.interTransferDelayMs, 1000);
  assert.equal(a.kermit.ackTimeoutMs, 10000);
  assert.equal(a.orderPoll.enabled, true, 'profile');
  assert.equal(a.orderPoll.download, true, 'profile');
  assert.deepEqual(a.orderPoll.downloadPrefixes, ['ZC'], 'site override merged beside the profile keys');
  assert.deepEqual(a.qc.patientPrefixes, ['ZC']);
  console.log('✓ vitros-250: kermit block with pacing');
}

// ---- 8) Maglumi: the analyzer dials us and host-queries -------------------
{
  const path = writeConfig('maglumi.json', [
    { id: 'site-maglumi', profile: 'snibe-maglumi', equipmentCode: 'MGAPI1000', transport: { port: 2807 } },
  ]);
  const a = loadConfig(path).analyzers[0]!;
  assert.equal(a.protocol, 'astm');
  assert.deepEqual(a.transport, { type: 'tcp', mode: 'server', host: '0.0.0.0', port: 2807 });
  assert.equal(a.hostQuery, true);
  assert.equal(a.orderPoll.enabled, false);
  assert.equal(a.sendDemographics, false);
  assert.equal(a.astm.dialect, 'maglumi');
  assert.equal(a.astm.receiverId, 'Lis');
  assert.ok(a.qc.sampleIdPrefixes.includes('$'));
  console.log('✓ snibe-maglumi: listener block with host query');
}

console.log('profiles: all checks passed');
