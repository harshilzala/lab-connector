import { ACK, ETX, STX, parseRollerFrame, rollerQueryReply } from '../src/codec/roller/parser.js';

// =============================================================================
// Roller probe — connectivity check for the Alifax ROLLER 20LC on a COM port.
//
// The ROLLER protocol has no "ping": the analyzer only ever SENDS (R results,
// Q "run this tube?" queries) and the host only replies. So this probe:
//
//   1. opens the port (proves the Moxa Real COM port is reachable and free),
//   2. reports the RS-232 control lines (CTS / DSR / DCD) once, then on every
//      change — on a fully-wired cable, DSR/CTS high = the analyzer is powered
//      and connected; on a 3-wire cable they stay low and prove nothing,
//   3. raises DTR/RTS so an analyzer that waits for them can talk,
//   4. listens: every byte is shown, every STX…ETX frame decoded and its
//      checksum checked,
//   5. answers a Q query with T "0001" (run the tube) and ACKs every R result —
//      exactly what the connector does — so BOTH directions are exercised.
//      --passive  : never send anything (pure listen)
//
// To get traffic, run a latex control or a tube on the ROLLER while it listens.
//
//   npm run roller-probe                       # COM1, 9600 8-N-1, 120 s
//   npm run roller-probe -- COM1 --seconds 300
//   npm run roller-probe -- COM1 --passive
//
// Only ONE program can hold a COM port: stop the connector (npm run dev /
// PM2 Lab-Interface) first, or the open fails with "Access denied".
// =============================================================================

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}
const positional = process.argv.slice(2).find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const portPath = positional ?? arg('port', 'COM1');
const baudRate = Number(arg('baud', '9600'));
const seconds = Number(arg('seconds', '120'));
const passive = process.argv.includes('--passive');

const NAMED: Record<number, string> = { 0x02: '<STX>', 0x03: '<ETX>', 0x06: '<ACK>', 0x15: '<NAK>', 0x0d: '<CR>', 0x0a: '<LF>' };
const show = (b: Buffer) =>
  Array.from(b, (c) => NAMED[c] ?? (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : `<0x${c.toString(16).padStart(2, '0')}>`)).join('');
const ts = () => { const d = new Date(); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
const log = (s: string) => console.log(`[${ts()}] ${s}`);

async function main(): Promise<void> {
  const { SerialPort } = await import('serialport');

  const ports = await SerialPort.list();
  const info = ports.find((p) => p.path.toUpperCase() === portPath.toUpperCase());
  if (!info) {
    console.error(`${portPath} not found. Ports on this machine: ${ports.map((p) => p.path).join(', ') || '(none)'}`);
    process.exit(2);
  }
  log(`${portPath}: ${[info.manufacturer, (info as { friendlyName?: string }).friendlyName].filter(Boolean).join(' | ')}`);

  const sp = new SerialPort({ path: portPath, baudRate, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false });
  await new Promise<void>((res) =>
    sp.open((err) => {
      if (err) {
        console.error(`OPEN FAILED: ${err.message}`);
        if (/denied|busy/i.test(err.message)) console.error('Another program holds the port — stop the connector (npm run dev / PM2 Lab-Interface) and retry.');
        process.exit(3);
      }
      res();
    }),
  );
  log(`OPEN OK — ${baudRate} 8-N-1, ${passive ? 'PASSIVE (nothing will be sent)' : 'will ACK results and answer queries'}, listening ${seconds}s`);

  await new Promise<void>((res) => sp.set({ dtr: true, rts: true }, () => res()));

  // --- control lines -------------------------------------------------------
  let lastLines = '';
  const readLines = () =>
    new Promise<string>((res) =>
      sp.get((err, s) => res(err || !s ? `unavailable (${err?.message ?? 'no status'})` : `CTS=${+s.cts} DSR=${+s.dsr} DCD=${+s.dcd}`)),
    );
  const pollLines = async () => {
    const now = await readLines();
    if (now !== lastLines) {
      log(`control lines: ${now}${lastLines ? '' : '   (1 = asserted by the analyzer side)'}`);
      lastLines = now;
    }
  };
  await pollLines();
  const linesTimer = setInterval(() => void pollLines(), 1000);

  // --- traffic ------------------------------------------------------------
  let bytesIn = 0;
  let frames = 0;
  let badFrames = 0;
  let sent = 0;
  let rx = Buffer.alloc(0);

  const send = (b: Buffer, what: string) => {
    if (passive) return;
    sp.write(b, (err) => {
      if (err) log(`SEND FAILED (${what}): ${err.message}`);
      else {
        sent++;
        log(`OUT ${show(b)}   (${what})`);
      }
    });
  };

  sp.on('data', (chunk: Buffer) => {
    bytesIn += chunk.length;
    log(`IN  ${show(chunk)}   (+${chunk.length} bytes)`);
    rx = Buffer.concat([rx, chunk]);
    for (;;) {
      const s = rx.indexOf(STX);
      if (s === -1) {
        rx = Buffer.alloc(0);
        break;
      }
      const e = rx.indexOf(ETX, s + 1);
      if (e === -1) {
        rx = rx.subarray(s);
        break;
      }
      const inner = rx.subarray(s + 1, e).toString('latin1');
      rx = rx.subarray(e + 1);
      frames++;
      const { message, checksumOk, reason } = parseRollerFrame(inner);
      if (!message) {
        badFrames++;
        log(`  frame not readable: ${reason}`);
        continue;
      }
      if (!checksumOk) badFrames++;
      const ck = checksumOk ? 'checksum OK' : 'CHECKSUM MISMATCH';
      if (message.kind === 'query') {
        log(`  QUERY  ws=${message.workstation} sample="${message.sampleId}"  ${ck}`);
        send(rollerQueryReply(message.workstation, message.sampleId, true), 'T reply: run tube');
      } else {
        log(
          `  RESULT ws=${message.workstation} sample="${message.sampleId}" ESR=${message.rawResult} (${message.outcome})` +
            ` rack=${message.rack} pos=${message.position} ${message.format}${message.isQc ? ' QC' : ''}  ${ck}`,
        );
        send(Buffer.from([ACK]), 'ACK');
      }
    }
  });
  sp.on('error', (err) => log(`serial error: ${err.message}`));

  // --- finish -------------------------------------------------------------
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(linesTimer);
    console.log('\n========== ROLLER probe summary ==========');
    console.log(`port           ${portPath} opened OK`);
    console.log(`control lines  ${lastLines}`);
    console.log(`bytes in       ${bytesIn}`);
    console.log(`frames         ${frames} (${badFrames} bad/checksum mismatch)`);
    console.log(`replies sent   ${passive ? '— (passive)' : sent}`);
    let verdict: string;
    if (frames > 0 && badFrames === 0) verdict = 'CONNECTED — the ROLLER is talking and frames decode cleanly.';
    else if (frames > 0) verdict = 'LINK UP BUT DIRTY — frames arrive with errors: check baud/parity on analyzer port 2 and the NPort, and the cable.';
    else if (bytesIn > 0) verdict = 'BYTES BUT NO FRAMES — wrong baud/parity (garbage) or a different protocol/format is selected on the ROLLER.';
    else
      verdict =
        'NO DATA — nothing reached this port. Was a tube/latex run during the window? If yes: check the ROLLER host-link setting, ' +
        'the cable to the NPort, and in the NPort web console (http://10.11.102.3) Monitor > Serial port RX/TX counters and Real COM mode.';
    console.log(`verdict        ${verdict}`);
    sp.close(() => process.exit(frames > 0 && badFrames === 0 ? 0 : 1));
    setTimeout(() => process.exit(1), 1000);
  };
  setTimeout(finish, seconds * 1000);
  process.on('SIGINT', finish);
}

void main();
