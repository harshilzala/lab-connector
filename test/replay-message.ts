import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { HmisClient } from '../src/hmis/client.js';
import { formatApiDate, normalizePending } from '../src/hmis/pending.js';
import { assayKey, parseMessage } from '../src/codec/astm/records.js';
import { parseResultFile } from '../src/codec/kermit/vitros250.js';
import { toLisResultRows, toResultUploads } from '../src/mapping/mapper.js';
import { logger } from '../src/logger.js';
import type { ParsedMessage } from '../src/types.js';

// =============================================================================
// Replay one captured analyzer message through the WHOLE connector pipeline:
//
//   wire text -> codec -> result upload -> join to HMIS pending rows -> POST
//
// Use it to prove what the connector would file for a message you already have,
// without waiting for the analyzer to send it again.
//
//   npm run replay -- vitros-eciq --file msg.txt        # read-only: show payload
//   echo "<message>" | npm run replay -- vitros-eciq    # read from stdin
//   npm run replay -- vitros-eciq --file msg.txt --post # actually file it
//
// ⚠️  WITHOUT --post NOTHING IS WRITTEN. The pending lookup is a GET, so the
//     default run is safe to repeat. --post writes real results to real patient
//     records — it is opt-in for that reason.
//
// Note what the payload is built from: every identifier except the value comes
// from the HMIS pending row, not the analyzer, because the endpoint files
// against labResultId. A barcode with no pending row therefore cannot be filed
// at all, and this tool will say so rather than inventing one.
// =============================================================================

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : undefined; };
const analyzerId = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--file');

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };

async function main(): Promise<void> {
  const cfg = loadConfig();
  const analyzer = cfg.analyzers.find((a) => a.id === analyzerId);
  if (!analyzer) {
    console.error(`Usage: npm run replay -- <analyzerId> [--file msg.txt] [--post]`);
    console.error(`Known analyzers: ${cfg.analyzers.map((a) => a.id).join(', ')}`);
    process.exit(1);
  }

  const file = opt('file');
  const text = file ? readFileSync(file, 'latin1') : readFileSync(0, 'latin1');
  const records = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (records.length === 0) {
    console.error('No message on stdin or in --file.');
    process.exit(1);
  }

  console.log(`\n${C.d}analyzer${C.x} ${analyzer.id}  ${C.d}protocol${C.x} ${analyzer.protocol}  ${C.d}eqCode${C.x} ${analyzer.equipmentCode}`);
  console.log(`${C.d}------------------------------------------------------------${C.x}`);
  console.log(`${C.y}[1] WIRE MESSAGE${C.x}`);
  for (const r of records) console.log(`    ${r}`);

  // ---- 1. codec -----------------------------------------------------------
  const msg: ParsedMessage =
    analyzer.protocol === 'kermit'
      ? parseResultFile(records.join(''))
      : parseMessage(records, records.join('\r\n'), analyzer.astm.dialect);

  console.log(`\n${C.y}[2] PARSED${C.x}  ${C.d}(dialect: ${analyzer.protocol === 'astm' ? analyzer.astm.dialect : 'vitros250'})${C.x}`);
  console.log(`    sender=${msg.sender ?? '-'}  queries=${msg.queries.length}  results=${msg.results.length}`);
  for (const r of msg.results) {
    console.log(`    sample=${r.sampleId}  test=${r.testCode}  value=${r.value}  unit=${r.unit ?? '-'}  flag=${r.abnormalFlag ?? '-'}  status=${r.status ?? '-'}  at=${r.completedAt ?? '-'}`);
  }
  if (msg.results.length === 0) {
    console.log(`    ${C.r}no results parsed — nothing to file${C.x}\n`);
    return;
  }

  // ---- 2. result uploads ---------------------------------------------------
  const uploads = toResultUploads(analyzer, msg);
  const hmis = new HmisClient({
    baseUrl: cfg.hmis.baseUrl,
    pendingPath: cfg.hmis.pendingPath,
    acknowledgePath: cfg.hmis.acknowledgePath,
    resultsPath: cfg.hmis.resultsPath,
    timeoutMs: cfg.hmis.timeoutMs,
    tlsRejectUnauthorized: cfg.hmis.tlsRejectUnauthorized,
    logger,
  });

  const ipAddress = analyzer.ipAddress ?? (analyzer.transport.type === 'tcp' ? analyzer.transport.host : '');
  const portNo = analyzer.portNo ?? (analyzer.transport.type === 'tcp' ? String(analyzer.transport.port) : '');

  for (const upload of uploads) {
    console.log(`\n${C.y}[3] HMIS PENDING LOOKUP${C.x}  ${C.d}GET ${cfg.hmis.baseUrl}${cfg.hmis.pendingPath}?sampleId=${upload.barcode}&eqCode=${analyzer.equipmentCode}${C.x}`);
    let orderRows;
    try {
      const body = await hmis.getPending({
        sampleId: upload.barcode,
        eqCode: analyzer.equipmentCode,
        siteId: analyzer.siteId,
        showCulture: analyzer.showCulture,
        date: analyzer.sendDate ? formatApiDate(new Date()) : undefined,
      });
      const pending = normalizePending(body, {
        sampleId: upload.barcode,
        eqCode: analyzer.equipmentCode,
        equipmentId: analyzer.equipmentId ?? null,
        ipAddress,
        portNo,
        // The rows were acknowledged at download time, so the server may be
        // flagging them transmitted already.
        includeTransmitted: true,
      });
      orderRows = pending.ackItems;
      console.log(`    ${orderRows.length} order row(s): ${orderRows.map((r) => `${r.identifier}(labResultId=${r.labResultId})`).join(', ') || '(none)'}`);
    } catch (err) {
      console.log(`    ${C.r}pending lookup failed: ${(err as Error).message}${C.x}`);
      continue;
    }

    // ---- 3. join -----------------------------------------------------------
    const { rows, unmatched } = toLisResultRows(
      upload,
      orderRows,
      analyzer.protocol === 'astm' ? assayKey(analyzer.astm.dialect) : undefined,
    );
    if (unmatched.length) {
      console.log(`    ${C.r}unmatched assay codes (no pending row, cannot be filed): ${unmatched.join(', ')}${C.x}`);
    }

    console.log(`\n${C.y}[4] PAYLOAD${C.x}  ${C.d}POST ${cfg.hmis.baseUrl}${cfg.hmis.resultsPath}  (bare array)${C.x}`);
    console.log(JSON.stringify(rows, null, 2));

    if (rows.length === 0) {
      console.log(`\n    ${C.r}nothing to POST — no analyzer result matched a pending order row${C.x}`);
      continue;
    }

    // ---- 4. POST -----------------------------------------------------------
    if (!flag('post')) {
      console.log(`\n    ${C.d}dry run — re-run with --post to actually file these ${rows.length} row(s)${C.x}`);
      continue;
    }
    console.log(`\n${C.y}[5] RESPONSE${C.x}`);
    try {
      const res = await hmis.postResults(rows);
      console.log(`    ${C.g}status=${res.status}  filed=${res.filed}/${rows.length}${C.x}  message=${res.message || '-'}`);
      console.log(JSON.stringify(res.successData, null, 2));
    } catch (err) {
      console.log(`    ${C.r}${(err as Error).message}${C.x}`);
    }
  }
  console.log('');
}

void main();
