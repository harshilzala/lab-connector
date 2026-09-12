import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WireAudit } from '../src/session/wire-audit.js';

const base = join(tmpdir(), `wire-audit-check-${process.pid}.log`);
const log = { warn: (...a: unknown[]) => console.error('warn', ...a) } as never;
const w = new WireAudit(base, log);
// Frames land in the day file beside base — wire-audit-check-<pid>-YYYY-MM-DD.log
const file = w.currentPath();

w.record({ at: '2026-09-07T01:00:00.000Z', direction: 'rx', text: 'MSH|^~\&|BC-6000|...' });
w.record({ at: '2026-09-07T01:00:01.000Z', direction: 'tx', text: 'ACK' });
w.record({ at: '2026-09-07T01:00:02.000Z', direction: 'rx', text: 'X'.repeat(9000) });

const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
console.log('lines written :', lines.length);
console.log('directions    :', lines.map((l) => l.direction).join(', '));
console.log('frame 1 text  :', lines[0].text);
console.log('oversized clip:', lines[2].text.length, 'chars,', lines[2].text.endsWith('more chars]') ? 'truncated marker present' : 'NOT TRUNCATED');
rmSync(file);
console.log(lines.length === 3 ? '\nOK' : '\nFAILED');
