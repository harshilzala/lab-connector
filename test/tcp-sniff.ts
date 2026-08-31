import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { ACK, ENQ, EOT, ETB, ETX, CONTROL_NAMES } from '../src/codec/astm/control.js';

// =============================================================================
// TCP sniffer — the Moxa-side twin of `npm run sniff` (which opens a COM port).
// Dumps EVERY byte an analyzer sends through a Moxa NPort in TCP Server mode,
// so a dialect can be confirmed against ground truth instead of a vendor PDF.
//
//   npm run sniff:tcp -- 10.20.1.54 4001            # connect to the NPort
//   npm run sniff:tcp -- 10.20.1.54 4001 --passive  # never write to the wire
//   npm run sniff:tcp -- --listen 2807              # or let the analyzer dial us
//   npm run sniff:tcp -- 10.20.1.53 4001 --out captures/vitros-250.log
//
// ⚠️  ACKING IS ON BY DEFAULT, and it has to be. ASTM E1381 is half-duplex and
//     interlocked: the analyzer sends ENQ and will not send a single frame until
//     the host answers ACK, then re-ACKs after every frame. A purely passive
//     listener therefore captures nothing but ENQ … ENQ … EOT on a 15s retry
//     loop, which looks exactly like a wiring fault. This tool answers ACK to
//     ENQ and to each frame — enough to make the analyzer transmit its whole
//     message — but it NEVER parses, replies with orders, or files anything.
//     Use --passive when you only want to prove which side opens the socket.
//
// Output:
//   • live hex+ASCII dump, ASTM control bytes named, to the console
//   • captures/<host>_<port>-<timestamp>.log   timestamped hex/ASCII
//   • captures/<host>_<port>-<timestamp>.bin   exact raw bytes, for replay
//
// IMPORTANT: a Moxa NPort in TCP Server mode accepts a limited number of
// connections. Stop the connector (pm2 stop lab-connector) before sniffing, or
// the analyzer's bytes will be split between the two of us.
// =============================================================================

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const listenPort = arg('listen');
const host = arg('host', positional[0]);
const port = Number(arg('port', positional[1] ?? '4001'));
const passive = hasFlag('passive');

function hexDump(buf: Buffer, offset: number): string {
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.subarray(i, i + 16);
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(16 * 3 - 1, ' ');
    const ascii = Array.from(slice, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`  ${(offset + i).toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
  }
  return lines.join('\n');
}

/** Name the ASTM control bytes in a chunk, so the log reads as a conversation. */
function controls(buf: Buffer): string {
  // Only the real control bytes — CR/LF are structural noise inside every
  // record, and naming data bytes would drown the line.
  const seen = Array.from(buf)
    .map((b) => CONTROL_NAMES[b])
    .filter((n): n is string => !!n && n !== 'CR' && n !== 'LF');
  return seen.length ? `  <${[...new Set(seen)].join(' ')}>` : '';
}

function attach(sock: Socket, label: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = label.replace(/[\\/:]/g, '_');
  const outLog = resolve(arg('out') ?? join('captures', `${safe}-${stamp}.log`));
  const outBin = outLog.replace(/\.log$/, '') + '.bin';
  mkdirSync(resolve('captures'), { recursive: true });
  const logStream = createWriteStream(outLog, { flags: 'a' });
  const binStream = createWriteStream(outBin, { flags: 'a' });

  const header = `# tcp capture ${label}  ${passive ? 'PASSIVE (no writes)' : 'auto-ACK'}  started ${new Date().toISOString()}\n`;
  logStream.write(header);
  console.log(header.trim());
  console.log(`# writing: ${outLog}`);
  console.log(`#          ${outBin}`);
  console.log('# waiting for data… (Ctrl+C to stop)\n');

  let total = 0;
  let chunks = 0;
  let acks = 0;

  sock.on('data', (chunk: Buffer) => {
    const block = `\n[${new Date().toISOString()}] +${chunk.length} bytes${controls(chunk)}\n${hexDump(chunk, total)}\n`;
    logStream.write(block);
    binStream.write(chunk);
    process.stdout.write(block);
    total += chunk.length;
    chunks += 1;

    if (passive) return;
    // Answer ENQ (establishment) and every frame terminator with ACK. EOT ends
    // the transmission and needs no reply. This is deliberately dumb: it does
    // not verify the checksum, because the point is to capture what the
    // analyzer sends, including anything malformed.
    const last = chunk[chunk.length - 1];
    const isFrameEnd = chunk.includes(ETX) || chunk.includes(ETB);
    if (chunk.includes(ENQ) || isFrameEnd) {
      if (last !== EOT) {
        sock.write(Buffer.from([ACK]));
        acks += 1;
        const note = `  -> ACK\n`;
        logStream.write(note);
        process.stdout.write(note);
      }
    }
  });

  sock.on('error', (err: Error) => console.error(`tcp error: ${err.message}`));
  sock.on('close', () => console.log(`\n# peer closed the connection after ${total} bytes`));

  const shutdown = () => {
    const summary = `\n# stopped ${new Date().toISOString()} — ${total} bytes in ${chunks} chunks, ${acks} ACKs sent\n`;
    logStream.write(summary);
    console.log(summary.trim());
    try {
      sock.destroy();
    } catch {
      /* already gone */
    }
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function main(): void {
  if (listenPort) {
    // The analyzer / Moxa dials us (Moxa "TCP Client" mode).
    const server = createServer((sock) => {
      console.log(`# inbound connection from ${sock.remoteAddress}:${sock.remotePort}`);
      attach(sock, `listen_${listenPort}`);
    });
    server.listen(Number(listenPort), '0.0.0.0', () =>
      console.log(`# listening on 0.0.0.0:${listenPort} — waiting for the analyzer to connect…`),
    );
    return;
  }

  if (!host) {
    console.error('Usage: npm run sniff:tcp -- <HOST> [PORT] [--passive] [--out file]');
    console.error('       npm run sniff:tcp -- --listen 2807');
    process.exit(1);
  }

  console.log(`# connecting to ${host}:${port}…`);
  const sock = createConnection({ host, port }, () => {
    console.log(`# connected to ${host}:${port}`);
    attach(sock, `${host}_${port}`);
  });
  sock.on('error', (err: Error) => {
    console.error(`Failed to connect to ${host}:${port}: ${err.message}`);
    console.error('If this is a Moxa NPort in Real COM mode (950/966 listening, 4001 closed) then');
    console.error('the analyzer is reached through its mapped COM port instead — use `npm run');
    console.error('sniff -- COMn`. Do not switch such an NPort to TCP Server without checking what');
    console.error('else is bound to that COM port; the Real COM mapping is what makes it work.');
    process.exit(1);
  });
}

main();
