// =============================================================================
// Connector Tool self-test.
//
// Exercises the three halves of the universal monitor without any hardware:
//
//   1. IDENTIFY  Replay one real transmission per protocol family through the
//                fingerprinter and pin which one it must pick. These are the
//                captures the tool exists to make sense of, so a change that
//                makes ASTM look like HL7 has to fail here.
//   2. PROBE     Stand up a fake analyzer on a loopback port, let the probe
//                capture its transmission, and check the auto-answer kept the
//                conversation going far enough to be identifiable.
//   3. DISCOVER  Sweep a loopback port that is genuinely open and confirm the
//                scan finds it (and does not invent hits on closed ports).
//
// Run: npx tsx test/connector-tool.test.ts
// =============================================================================
import net from 'node:net';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identify, parsePayload, renderBytes, knownProtocols, FAMILY_LABELS } from '../src/probe/identify.js';
import { frame } from '../src/codec/astm/checksum.js';
import { ETX } from '../src/codec/astm/control.js';
import { ProbeSession } from '../src/probe/session.js';
import { scanTcp, expandHosts } from '../src/probe/discover.js';
import { logger } from '../src/logger.js';

let checks = 0;
function check(what: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`  ok  ${what}`);
}

// -----------------------------------------------------------------------------
// 1. Identify
// -----------------------------------------------------------------------------
console.log('\nidentify — one real transmission per protocol family');

// Framed by the production E1381 framer, not by a copy of it here: a capture
// this connector could not itself have produced would prove nothing about the
// fingerprinter.
function astmFrame(seq: number, record: string): string {
  return frame(seq, `${record}\r`, ETX).toString('latin1');
}

const ASTM_CAPTURE = Buffer.from(
  '\x05' +
    astmFrame(1, 'H|\\^&|||Maglumi||||||||E1394-97|P|20260908120000') +
    astmFrame(2, 'P|1') +
    astmFrame(3, 'O|1|SAMP001||^^^CA125|R') +
    astmFrame(4, 'R|1|^^^CA125|12.4|U/mL||N||F') +
    astmFrame(5, 'L|1|N') +
    '\x04',
  'latin1',
);

check('a checksummed E1381 transmission is identified as ASTM', () => {
  const r = identify(ASTM_CAPTURE);
  const top = r.candidates[0]!;
  assert.equal(top.id, 'astm-e1381', `top candidate was ${top.id}`);
  assert.equal(top.supported, 'astm');
  assert.ok(top.confidence >= 0.9, `confidence ${top.confidence} is too low for a verified capture`);
  assert.ok(
    top.evidence.some((e) => /checksum\(s\) verified/.test(e)),
    'the verified checksum must appear in the evidence — it is the decisive signal',
  );
  assert.equal(r.suggestion?.protocol, 'astm');
});

// The Radiometer ABL9: E1394 records with no E1381 framing at all.
const ABL9_CAPTURE = Buffer.from(
  '\x01H|\\^&|||ABL9^^^|||||||P|1|20260908120000\r' +
    'P|1||||^^\r' +
    'O|1|ZC26090001||^^^^BLOODGAS|R\r' +
    'R|1|^^^pH|7.41||||N||F\r' +
    'R|2|^^^pCO2|41.2|mmHg|||N||F\r' +
    'L|1|N\r\x04',
  'latin1',
);

check('unframed E1394 records are identified as the ABL9 link, not ASTM', () => {
  const r = identify(ABL9_CAPTURE);
  const top = r.candidates[0]!;
  assert.equal(top.id, 'astm-raw-records', `top candidate was ${top.id}`);
  assert.equal(top.supported, 'abl9');
  // The whole point of the split: no E1381 detector may claim this stream.
  assert.ok(!r.candidates.some((c) => c.id === 'astm-e1381'), 'the E1381 detector must not fire without framing');
});

const HL7_CAPTURE = Buffer.from(
  '\x0bMSH|^~\\&|H360|ERBA|HMIS|ZYDUS|20260908120000||ORU^R01|MSG0001|P|2.5\r' +
    'PID|1||CH2609070001||DOE^JOHN\r' +
    'OBR|1||CH2609070001|CBC\r' +
    'OBX|1|NM|WBC||7.4|10^3/uL|||||F\r' +
    'OBX|2|NM|HGB||13.8|g/dL|||||F\r' +
    '\x1c\r',
  'latin1',
);

check('an MLLP block is identified as HL7 v2', () => {
  const r = identify(HL7_CAPTURE);
  const top = r.candidates[0]!;
  assert.equal(top.id, 'hl7-v2', `top candidate was ${top.id}`);
  assert.equal(top.supported, 'hl7');
  assert.ok(top.confidence >= 0.8);
  assert.equal((top.hints as Record<string, unknown>)?.sendingApp, 'H360');
});

// A Kermit Send-Init followed by a data packet and EOF — the VITROS 250 link.
function kermitPacket(seq: number, type: string, data: string): string {
  const len = data.length + 3;
  return `\x01${String.fromCharCode(len + 32)}${String.fromCharCode(seq + 32)}${type}${data}#\r`;
}
const KERMIT_CAPTURE = Buffer.from(
  kermitPacket(0, 'S', ' " @-#N1') + kermitPacket(1, 'F', 'SAMPLE.DAT') + kermitPacket(2, 'D', 'ZC001 GLU') + kermitPacket(3, 'Z', ''),
  'latin1',
);

check('a Kermit transfer is identified as the VITROS 250 link', () => {
  const r = identify(KERMIT_CAPTURE);
  const top = r.candidates[0]!;
  assert.equal(top.id, 'kermit', `top candidate was ${top.id}`);
  assert.equal(top.supported, 'kermit');
  assert.ok(top.evidence.some((e) => /Send-Init/.test(e)), 'a complete transfer must be called out');
});

check('a JSON device API is recognised, and flagged as not implemented', () => {
  const r = identify(Buffer.from('{"sample":"ZC001","results":[{"test":"GLU","value":94}]}'));
  const top = r.candidates[0]!;
  assert.equal(top.id, 'json');
  assert.equal(top.supported, null);
  assert.equal(r.suggestion, null, 'no config block may be offered for a protocol we cannot speak');
});

check('a Modbus/TCP frame is recognised from its MBAP header', () => {
  // txn 0x0001, protocol 0x0000, length 6, unit 1, fn 3 (read holding regs).
  const frame = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x01, 0x03, 0x00, 0x00, 0x00, 0x02]);
  const r = identify(frame);
  assert.ok(r.candidates.some((c) => c.id === 'modbus-tcp'), 'Modbus must be among the candidates');
});

check('an empty capture says so rather than guessing', () => {
  const r = identify(Buffer.alloc(0));
  assert.equal(r.bytes, 0);
  assert.equal(r.suggestion, null);
  assert.ok(r.observations[0]!.includes('nothing captured'));
});

check('every detector is reachable and declares its support status', () => {
  const protos = knownProtocols();
  assert.ok(protos.length >= 12, `only ${protos.length} detectors registered`);
  const supported = protos.filter((p) => p.supported).map((p) => p.supported);
  // Every protocol the connector implements must be identifiable, or the tool
  // cannot commission the machines we already run.
  for (const p of ['astm', 'abl9', 'hl7', 'kermit', 'advia2120i', 'clinitek-advantus']) {
    assert.ok(supported.includes(p), `no detector maps to protocol "${p}"`);
  }
});

// -----------------------------------------------------------------------------
// The wider device estate. One structural fixture per family — each is built
// from the protocol's own arithmetic (a real CRC, a real length field, a real
// magic number), never from vocabulary, because vocabulary is what makes a
// fingerprinter confidently wrong.
// -----------------------------------------------------------------------------
console.log('\nidentify — monitors, ventilators, imaging and the buses underneath');

check('an IEEE 11073-20601 association request is recognised', () => {
  // AARQ tag 0xE200, length, then the -20601 data-proto-id 0x5079.
  const body = Buffer.from([0x80, 0x00, 0x00, 0x00, 0x50, 0x79, 0x00, 0x02, 0x00, 0x00]);
  const apdu = Buffer.concat([Buffer.from([0xe2, 0x00, 0x00, body.length]), body]);
  const r = identify(apdu);
  const top = r.candidates[0]!;
  assert.equal(top.id, 'ieee11073-phd', `top candidate was ${top.id}`);
  assert.equal(top.family, 'monitor');
  assert.ok(top.evidence.some((e) => /20601/.test(e)), 'the data-proto-id must be called out');
});

check('a ventilator-class ASCII frame is recognised by its verified checksum', () => {
  // The Dräger MEDIBUS / Nihon Kohden / Spacelabs shape: a control opener,
  // printable payload, two hex checksum digits, CR.
  const frame = (payload: string) => {
    let sum = 0;
    for (const c of payload) sum = (sum + c.charCodeAt(0)) & 0xff;
    return '\x01' + payload + sum.toString(16).toUpperCase().padStart(2, '0') + '\r';
  };
  const r = identify(Buffer.from(frame('R0100') + frame('Q2050') + frame('S0031'), 'latin1'));
  const top = r.candidates[0]!;
  assert.equal(top.id, 'vendor-ascii-framed', `top candidate was ${top.id}`);
  assert.ok(
    top.evidence.some((e) => /3\/3 frame checksum\(s\) verified/.test(e)),
    'the arithmetic is the evidence — vocabulary is not',
  );
  // It must name the vendors as candidates to check, not pick one.
  assert.ok(top.evidence.some((e) => /MEDIBUS/.test(e)));
  assert.equal(top.supported, null);
});

check('Modbus RTU is claimed only on a verified CRC-16', () => {
  // Read holding registers: unit 1, fn 3, addr 0, count 2 — with a real CRC.
  const body = Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x02]);
  let crc = 0xffff;
  for (const b of body) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  const good = Buffer.concat([body, Buffer.from([crc & 0xff, crc >> 8])]);
  const r = identify(good);
  assert.ok(
    r.candidates.some((c) => c.id === 'modbus-rtu'),
    'a frame with a valid CRC must be recognised',
  );

  // Corrupt the CRC and the claim has to disappear — otherwise the detector is
  // matching on shape, which is exactly what it must not do.
  const bad = Buffer.from(good);
  bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
  assert.ok(
    !identify(bad).candidates.some((c) => c.id === 'modbus-rtu'),
    'a broken CRC must not be reported as Modbus RTU',
  );
});

check('a TLS ClientHello is reported as an encrypted port, not a mystery', () => {
  const hello = Buffer.concat([
    Buffer.from([0x16, 0x03, 0x01, 0x00, 0x2a]), // handshake, TLS 1.0 record, length
    Buffer.from([0x01, 0x00, 0x00, 0x26, 0x03, 0x03]), // ClientHello
    Buffer.alloc(0x24),
  ]);
  const r = identify(hello);
  const top = r.candidates[0]!;
  assert.equal(top.id, 'tls', `top candidate was ${top.id}`);
  assert.ok(
    top.evidence.some((e) => /ENCRYPTED/.test(e)),
    'the operator must be told plainly that a raw probe cannot work here',
  );
});

check('telnet negotiation is flagged as a terminal server in the wrong mode', () => {
  const iac = Buffer.from([0xff, 0xfd, 0x18, 0xff, 0xfb, 0x03, 0xff, 0xfd, 0x1f]);
  const r = identify(iac);
  const top = r.candidates[0]!;
  assert.equal(top.id, 'telnet', `top candidate was ${top.id}`);
  assert.ok(top.evidence.some((e) => /RAW/.test(e)), 'the fix — switch the port to raw — must be stated');
});

check('an XMODEM block is recognised by its ones-complement block number', () => {
  const block1 = Buffer.concat([Buffer.from([0x01, 0x01, 0xfe]), Buffer.alloc(128, 0x41), Buffer.from([0x2a])]);
  const block2 = Buffer.concat([Buffer.from([0x01, 0x02, 0xfd]), Buffer.alloc(128, 0x42), Buffer.from([0x2b])]);
  const r = identify(Buffer.concat([block1, block2]));
  assert.ok(r.candidates.some((c) => c.id === 'xmodem'), 'XMODEM must be among the candidates');
});

check('OPC UA binary is recognised from its message header', () => {
  const hel = Buffer.alloc(40);
  hel.write('HELF', 0, 'latin1');
  hel.writeUInt32LE(40, 4);
  const r = identify(hel);
  assert.equal(r.candidates[0]!.id, 'opcua', `top candidate was ${r.candidates[0]!.id}`);
});

check('MQTT is recognised from its CONNECT protocol name', () => {
  const connect = Buffer.concat([
    Buffer.from([0x10, 0x0e]), // CONNECT, remaining length 14
    Buffer.from([0x00, 0x04]),
    Buffer.from('MQTT', 'latin1'),
    Buffer.from([0x04, 0x02, 0x00, 0x3c, 0x00, 0x04]),
    Buffer.from('dev1', 'latin1'),
  ]);
  const r = identify(connect);
  assert.equal(r.candidates[0]!.id, 'mqtt', `top candidate was ${r.candidates[0]!.id}`);
});

check('BACnet/IP is recognised from its BVLC header', () => {
  const bvlc = Buffer.concat([Buffer.from([0x81, 0x0a, 0x00, 0x0c]), Buffer.alloc(8)]);
  const r = identify(bvlc);
  assert.ok(r.candidates.some((c) => c.id === 'bacnet-ip'), 'BACnet must be among the candidates');
});

check('SNMP is recognised, and named as the management plane', () => {
  const snmp = Buffer.concat([
    Buffer.from([0x30, 0x1c, 0x02, 0x01, 0x01, 0x04, 0x06]),
    Buffer.from('public', 'latin1'),
    Buffer.alloc(15),
  ]);
  const r = identify(snmp);
  const hit = r.candidates.find((c) => c.id === 'snmp');
  assert.ok(hit, 'SNMP must be among the candidates');
  assert.ok(hit!.evidence.some((e) => /management plane/.test(e)));
});

check('a DICOM association carries both its PDU type and its UID root', () => {
  const pdu = Buffer.concat([
    Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x40]),
    Buffer.from('1.2.840.10008.3.1.1.1', 'latin1'),
    Buffer.alloc(20),
  ]);
  const r = identify(pdu);
  const top = r.candidates[0]!;
  assert.equal(top.id, 'dicom', `top candidate was ${top.id}`);
  assert.equal(top.family, 'imaging');
  assert.ok(top.evidence.some((e) => /A-ASSOCIATE-RQ/.test(e)));
  assert.ok(top.evidence.some((e) => /1\.2\.840\.10008/.test(e)));
});

check('a FHIR resource is recognised and routed to an HTTP client', () => {
  const r = identify(Buffer.from('{"resourceType":"Observation","status":"final","valueQuantity":{"value":7.4}}'));
  const top = r.candidates[0]!;
  assert.equal(top.id, 'fhir', `top candidate was ${top.id}`);
  assert.equal(top.family, 'interop');
  assert.ok(top.evidence.some((e) => /REST API/.test(e)));
});

check('a CDA document is recognised', () => {
  const r = identify(Buffer.from('<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3"><id/></ClinicalDocument>'));
  assert.equal(r.candidates[0]!.id, 'hl7-v3-cda', `top candidate was ${r.candidates[0]!.id}`);
});

check('a POCT1-A exchange is recognised', () => {
  const poct =
    '<?xml version="1.0"?><HELLO.R01><HDR><HDR.control_id V="1"/></HDR><DEV.device_id V="ABL9"/></HELLO.R01>';
  const r = identify(Buffer.from(poct));
  const top = r.candidates[0]!;
  assert.equal(top.id, 'poct1a', `top candidate was ${top.id}`);
  assert.equal(top.family, 'monitor');
});

check('a print stream is recognised, with the right advice', () => {
  const r = identify(Buffer.from('^XA^FO50,50^ADN,36,20^FDZC2609070001^FS^XZ'));
  const top = r.candidates[0]!;
  assert.equal(top.id, 'print-stream', `top candidate was ${top.id}`);
  assert.ok(
    top.evidence.some((e) => /PRINTING/.test(e)),
    'an analyzer that only prints is a real and common commissioning outcome',
  );
});

check('an FTP greeting is flagged as a likely result-file export', () => {
  const r = identify(Buffer.from('220 Analyzer FTP service ready.\r\n'));
  const top = r.candidates[0]!;
  assert.equal(top.id, 'service-banner', `top candidate was ${top.id}`);
  assert.ok(top.evidence.some((e) => /RESULT FILES|FTP/.test(e)));
});

check('raw HL7 with no MLLP framing is still identified, and says so', () => {
  const raw = 'MSH|^~\\&|LAB|H|HMIS|Z|20260908||ORU^R01|1|P|2.5\rOBX|1|NM|GLU||94|mg/dL\r';
  const r = identify(Buffer.from(raw, 'latin1'));
  const top = r.candidates[0]!;
  assert.equal(top.id, 'hl7-v2', `top candidate was ${top.id}`);
  assert.ok(
    top.evidence.some((e) => /NO MLLP framing/.test(e)),
    'the missing framing changes how the codec must be configured, so it must be reported',
  );
});

// -----------------------------------------------------------------------------
// Honesty rules the whole detector set must obey.
// -----------------------------------------------------------------------------
console.log('\nidentify — the rules every detector has to obey');

check('generic shapes are suppressed once a real protocol matches', () => {
  const r = identify(ASTM_CAPTURE);
  for (const shape of ['delimited-text', 'binary-unknown', 'xml-generic']) {
    assert.ok(
      !r.candidates.some((c) => c.id === shape),
      `"${shape}" must not crowd the ranking once ASTM has matched`,
    );
  }
  // With nothing specific to match, the shape detector is exactly what we want.
  const shapes = identify(Buffer.from('a,b,c\r\nd,e,f\r\n'));
  assert.ok(shapes.candidates.some((c) => c.id === 'delimited-text'));
});

check('no detector offers a config block for a protocol we cannot speak', () => {
  for (const p of knownProtocols()) {
    if (p.supported) continue;
    assert.ok(
      ['astm', 'abl9', 'hl7', 'kermit', 'advia2120i', 'clinitek-advantus'].every((x) => x !== p.id),
      `${p.id} claims to be unsupported but shares a name with a codec`,
    );
  }
});

check('every detector declares a family the UI can group it under', () => {
  const families = new Set(Object.keys(FAMILY_LABELS));
  for (const p of knownProtocols()) {
    assert.ok(families.has(p.family), `${p.id} has family "${p.family}", which the UI cannot label`);
  }
  // Each family must actually be populated, or the label is dead weight.
  for (const f of families) {
    assert.ok(knownProtocols().some((p) => p.family === f), `no detector belongs to the "${f}" family`);
  }
});

check('every protocol this connector implements remains identifiable', () => {
  const supported = knownProtocols().filter((p) => p.supported).map((p) => p.supported);
  for (const p of ['astm', 'abl9', 'hl7', 'kermit', 'advia2120i', 'clinitek-advantus']) {
    assert.ok(supported.includes(p), `no detector maps to protocol "${p}"`);
  }
});

// -----------------------------------------------------------------------------
// Payload parsing — what the operator types must reach the wire verbatim.
// -----------------------------------------------------------------------------
console.log('\npayload parsing — operator input to bytes and back');

check('control-character mnemonics round-trip', () => {
  const buf = parsePayload('<ENQ>H|\\^&<CR><LF>', 'text');
  assert.equal(buf[0], 0x05);
  assert.equal(buf[buf.length - 2], 0x0d);
  assert.equal(buf[buf.length - 1], 0x0a);
  assert.equal(renderBytes(buf), '<ENQ>H|\\^&<CR><LF>');
});

check('backslash and hex escapes are honoured', () => {
  assert.deepEqual([...parsePayload('\\x02A\\r\\n', 'text')], [0x02, 0x41, 0x0d, 0x0a]);
  assert.deepEqual([...parsePayload('02 41 0D', 'hex')], [0x02, 0x41, 0x0d]);
});

check('a malformed hex payload is rejected, not silently truncated', () => {
  assert.throws(() => parsePayload('02 4', 'hex'), /odd number of digits/);
});

// -----------------------------------------------------------------------------
// 2. Probe against a fake analyzer
// -----------------------------------------------------------------------------
console.log('\nprobe — capture a live transmission from a fake analyzer');

/** A fake ASTM analyzer that dials the probe and waits for ACKs, as a real one does. */
function fakeAnalyzer(port: number): Promise<{ acksSeen: number }> {
  return new Promise((resolve, reject) => {
    const frames = [
      astmFrame(1, 'H|\\^&|||FakeLab||||||||E1394-97|P|20260908120000'),
      astmFrame(2, 'O|1|PROBE001||^^^GLU|R'),
      astmFrame(3, 'R|1|^^^GLU|94|mg/dL||N||F'),
      astmFrame(4, 'L|1|N'),
    ];
    let acksSeen = 0;
    let sent = -1; // -1 = the ENQ has yet to be acknowledged
    const socket = net.connect(port, '127.0.0.1', () => socket.write('\x05'));
    socket.on('data', (chunk) => {
      for (const b of chunk) {
        if (b !== 0x06) continue; // only ACK moves the state machine on
        acksSeen++;
        sent++;
        if (sent < frames.length) socket.write(Buffer.from(frames[sent]!, 'latin1'));
        else {
          socket.write('\x04');
          socket.end();
        }
      }
    });
    socket.on('close', () => resolve({ acksSeen }));
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error('the fake analyzer timed out — the probe never answered'));
    }, 8000).unref();
  });
}

const PROBE_PORT = 45871;
const captureDir = mkdtempSync(join(tmpdir(), 'connector-tool-'));
const probe = new ProbeSession(
  {
    transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: PROBE_PORT },
    autoAck: true,
    maxCaptureBytes: 1024 * 1024,
    maxEvents: 500,
  },
  logger.child({ mod: 'connector-tool-test' }),
  captureDir,
);

await probe.start();
assert.equal(probe.snapshot().running, true);

const analyzer = await fakeAnalyzer(PROBE_PORT);

// Give the last inbound chunk a moment to land before reading the capture.
await new Promise((r) => setTimeout(r, 200));

check('auto-answer kept the analyzer transmitting to the end', () => {
  // ENQ + four frames = five ACKs. Without auto-answer the analyzer stalls
  // after the ENQ and the capture is one byte long.
  assert.ok(analyzer.acksSeen >= 5, `the analyzer saw only ${analyzer.acksSeen} ACKs`);
});

check('the probe captured the whole transmission', () => {
  const buf = probe.buffer();
  // Every record the analyzer sent has to be there — a byte count would only
  // pin the fixture, not that nothing was dropped mid-stream.
  const text = buf.toString('latin1');
  for (const record of ['H|', 'O|1|PROBE001', 'R|1|^^^GLU|94', 'L|1|N']) {
    assert.ok(text.includes(record), `the ${record} record never reached the capture`);
  }
  assert.ok(buf.includes(0x05), 'the opening ENQ is missing from the capture');
  assert.ok(buf.includes(0x04), 'the closing EOT is missing from the capture');
});

check('the captured stream identifies as ASTM with a config block', () => {
  const r = probe.analyze();
  assert.equal(r.candidates[0]!.id, 'astm-e1381');
  const s = r.suggestion as Record<string, unknown>;
  assert.equal(s.protocol, 'astm');
  // The suggestion must carry back the transport the probe actually used, so
  // the block can be pasted without re-typing the endpoint.
  assert.deepEqual(s.transport, { type: 'tcp', mode: 'server', host: '127.0.0.1', port: PROBE_PORT });
});

check('the wire log records both directions', () => {
  const log = probe.log();
  assert.ok(log.some((e) => e.direction === 'IN'));
  assert.ok(log.some((e) => e.direction === 'OUT' && e.text.includes('[auto] <ACK>')));
  assert.ok(log.some((e) => e.direction === 'SYS' && /peer connected/.test(e.text)));
});

check('a capture can be written to disk', () => {
  const saved = probe.save();
  assert.equal(saved.bytes, probe.buffer().length, 'the file on disk must hold the whole capture');
  assert.ok(saved.bin.endsWith('.bin') && saved.log.endsWith('.log'));
});

check('clearing resets the capture but leaves the probe running', () => {
  probe.clear();
  assert.equal(probe.buffer().length, 0);
  assert.equal(probe.log().length, 0);
  assert.equal(probe.snapshot().running, true);
});

await probe.stop();
check('a stopped probe releases the port', async () => {
  assert.equal(probe.snapshot().running, false);
});

// -----------------------------------------------------------------------------
// 3. Discover
// -----------------------------------------------------------------------------
console.log('\ndiscover — find an open port and ignore closed ones');

check('host specs expand to the right addresses', () => {
  assert.deepEqual(expandHosts('10.12.19.42'), ['10.12.19.42']);
  assert.equal(expandHosts('10.12.19.1-10').length, 10);
  assert.equal(expandHosts('10.12.19.0/29').length, 6); // /29 less network + broadcast
  assert.throws(() => expandHosts('10.0.0.0/8'), /only \/22 to \/32/);
});

const listener = net.createServer((s) => s.write('MSH|^~\\&|DEVICE|LAB|||\r'));
await new Promise<void>((r) => listener.listen(45872, '127.0.0.1', r));

const scan = await scanTcp({ host: '127.0.0.1', ports: [45872, 45873], connectTimeoutMs: 500, bannerWaitMs: 400 });
await new Promise<void>((r) => listener.close(() => r()));

check('the scan finds the open port and only the open port', () => {
  assert.equal(scan.scanned, 2);
  assert.equal(scan.hits.length, 1, 'a closed port must not produce a hit');
  assert.equal(scan.hits[0]!.port, 45872);
});

check('a device that greets on connect is recognised from its banner', () => {
  assert.ok(scan.hits[0]!.banner?.includes('MSH|'), 'the greeting was not captured');
  assert.match(scan.hits[0]!.guess ?? '', /HL7/);
});

console.log(`\n${checks} checks passed\n`);
