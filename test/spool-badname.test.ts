// Regression: a Maglumi QC record arrived with sample id `KN TG 2 <0.02`, and
// the `<` made writeFileSync fail with ENOENT on Windows — the result was
// dropped on the floor. Enqueue must fold the id and still round-trip it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpoolQueue } from '../src/queue/spool.js';

const dir = mkdtempSync(join(tmpdir(), 'spool-test-'));
const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
const q = new SpoolQueue<{ barcode: string }>(dir, logger);

const badId = 'KN TG 2 <0.02-6b0e8081e5cb6c63f871907d';
const id = q.enqueue({ barcode: 'KN TG 2 <0.02' }, badId);
console.log('enqueued as:', id);

const pending = q.listPending();
console.log('pending count:', pending.length);
console.log('round-trips:', pending[0]?.id === id);
console.log('payload intact:', pending[0]?.payload.barcode === 'KN TG 2 <0.02');

const clean = q.enqueue({ barcode: 'LB2609020570' }, 'LB2609020570-abc123def456');
console.log('clean id untouched:', clean === 'LB2609020570-abc123def456');
console.log('total pending:', q.counts().pending);

rmSync(dir, { recursive: true, force: true });
