import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// =============================================================================
// Serial sniffer — open a COM port read-only and dump EVERY byte the analyzer
// sends, with zero parsing. Use it to capture a real transmission from the
// CLINITEK Advantus (COM3) or ADVIA 2120i (COM1) so the codecs can be confirmed
// against ground truth.
//
//   npm run sniff -- --list                       # list available serial ports
//   npm run sniff -- COM3                          # sniff COM3 @ 9600-8-N-1
//   npm run sniff -- COM1 --baud 9600 --parity none
//   npm run sniff -- COM3 --out captures/advantus.log
//
// Output (per port):
//   • live hex+ASCII dump to the console
//   • captures/<port>-<timestamp>.log   human-readable hex/ASCII, timestamped
//   • captures/<port>-<timestamp>.bin   exact raw bytes (for byte-perfect replay)
//
// IMPORTANT: only ONE program can hold a COM port. Stop the old middleware (and
// the connector) before sniffing, or the open will fail with "Access denied".
// Press Ctrl+C to stop; a summary is printed on exit.
// =============================================================================

type Parity = 'none' | 'even' | 'odd' | 'mark' | 'space';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

// First non-flag argument after the script is the port (convenience form).
const positional = process.argv.slice(2).find((a) => !a.startsWith('--'));

const port = arg('port', positional);
const baudRate = Number(arg('baud', '9600'));
const dataBits = Number(arg('databits', '8')) as 5 | 6 | 7 | 8;
const stopBits = Number(arg('stopbits', '1')) as 1 | 2;
const parity = (arg('parity', 'none') as Parity);

async function loadSerialPort(): Promise<any> {
  try {
    return await import('serialport');
  } catch {
    console.error('The "serialport" package is not installed. Run: npm install serialport');
    process.exit(1);
  }
}

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

async function main(): Promise<void> {
  const { SerialPort } = await loadSerialPort();

  if (hasFlag('list')) {
    const ports = await SerialPort.list();
    if (!ports.length) {
      console.log('No serial ports found.');
      return;
    }
    console.log('Available serial ports:');
    for (const p of ports) {
      console.log(`  ${p.path}\t${[p.manufacturer, p.friendlyName, p.pnpId].filter(Boolean).join(' | ') || '(no description)'}`);
    }
    return;
  }

  if (!port) {
    console.error('Usage: npm run sniff -- <PORT> [--baud 9600] [--parity none] [--out file]');
    console.error('       npm run sniff -- --list');
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safePort = port.replace(/[\\/:]/g, '_');
  const outLog = resolve(arg('out') ?? join('captures', `${safePort}-${stamp}.log`));
  const outBin = outLog.replace(/\.log$/, '') + '.bin';
  mkdirSync(resolve('captures'), { recursive: true });
  const logStream = createWriteStream(outLog, { flags: 'a' });
  const binStream = createWriteStream(outBin, { flags: 'a' });

  const header =
    `# serial capture ${port} @ ${baudRate}-${dataBits}-${parity[0]!.toUpperCase()}-${stopBits}  started ${new Date().toISOString()}\n`;
  logStream.write(header);
  console.log(header.trim());
  console.log(`# writing: ${outLog}`);
  console.log(`#          ${outBin}`);
  console.log('# waiting for data… (Ctrl+C to stop)\n');

  const sp = new SerialPort(
    { path: port, baudRate, dataBits, stopBits, parity },
    (err: Error | null) => {
      if (err) {
        console.error(`Failed to open ${port}: ${err.message}`);
        console.error('Is the old middleware/connector still holding the port? Close it and retry.');
        process.exit(1);
      }
    },
  );

  let total = 0;
  let chunks = 0;

  sp.on('data', (chunk: Buffer) => {
    const ts = new Date().toISOString();
    const block = `\n[${ts}] +${chunk.length} bytes\n${hexDump(chunk, total)}\n`;
    logStream.write(block);
    binStream.write(chunk);
    process.stdout.write(block);
    total += chunk.length;
    chunks += 1;
  });

  sp.on('error', (err: Error) => console.error(`serial error: ${err.message}`));

  const shutdown = () => {
    const summary = `\n# stopped ${new Date().toISOString()} — ${total} bytes in ${chunks} chunks\n`;
    logStream.write(summary);
    console.log(summary.trim());
    try {
      sp.close(() => process.exit(0));
    } catch {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
