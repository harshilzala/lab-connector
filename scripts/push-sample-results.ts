// One-off re-file of a sample's staged values to HMIS, with the instrument code
// mapped BY HAND to the row HMIS currently offers for that sample.
//
// Why this exists: the connector matches the instrument's assay code to the
// pending row's eqIdntifier exactly. When HMIS's equipment-parameter master is
// spelled in report names ("HAEMOGLOBIN", "Neutrophils"), the values strand,
// and two codes ("WBC", "RBC") match the peripheral-smear rows instead of the
// counts. This script sends each value to the RIGHT row so a sample can be
// completed while the master is being corrected, and prints the gateway's
// verdict per row. It goes through the connector's own HmisClient + audit log,
// so the call is recorded in logs/hmis-YYYY-MM-DD.log like any other upload.
//
//   Run:  npx tsx scripts/push-sample-results.ts <analyzer-id> <barcode>
//   e.g.  npx tsx scripts/push-sample-results.ts zhp-bc5150 PL2609120001
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { HmisClient } from '../src/hmis/client.js';
import { HmisAudit } from '../src/hmis/audit.js';
import { logger } from '../src/logger.js';

const [analyzerId, BARCODE] = process.argv.slice(2);
if (!analyzerId || !BARCODE) {
  console.error('usage: npx tsx scripts/push-sample-results.ts <analyzer-id> <barcode>');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '..');
const cfg = loadConfig(resolve(root, 'config.json'));
const an = cfg.analyzers.find((a) => a.id === analyzerId);
if (!an) throw new Error(`no analyzer "${analyzerId}" in config.json`);
const audit = cfg.hmis.auditLog
  ? new HmisAudit(resolve(root, cfg.hmis.auditLog), logger.child({ mod: 'hmis-audit' }), cfg.hmis.auditMaxBytes)
  : undefined;
const hmis = new HmisClient({ ...cfg.hmis, logger, audit });

// Instrument code -> the identifier HMIS spells that parameter with on the
// sample's pending rows (the ZHPN001 master as of 2026-09-12 12:42 IST).
const BY_IDENTIFIER: Record<string, string> = {
  WBC: 'WBC COUNT', RBC: 'RBC COUNT', HGB: 'HAEMOGLOBIN', HCT: 'HEMATOCRIT', PLT: 'PLATELET COUNT',
  MCV: 'MCV', MCH: 'MCH', MCHC: 'MCHC', 'RDW-CV': 'RDW-CV', MPV: 'MPV',
  'NEU%': 'Neutrophils', 'LYM%': 'Lymphocytes', 'MON%': 'Monocytes', 'EOS%': 'Eosinophils', 'BAS%': 'Basophils',
  'NEU#': 'Absolute Neutrophil count', 'LYM#': 'Absolute Lymphocyte count*', 'EOS#': 'Absolute Eosinophil count',
};
// Codes with no row on the CBC panel: the parameterId HMIS itself offered for
// them under the pre-12:42 master (spool/<id>/parameters.json), which HMIS
// accepted for this sample at 19:11 on 2026-09-12.
const BY_PARAMETER_ID: Record<string, number> = { 'MON#': 11304, 'BAS#': 11305, PDW: 7002, PCT: 6964 };

const staged = JSON.parse(readFileSync(resolve(root, cfg.spoolDir, an.id, 'results', `${BARCODE}.json`), 'utf8')) as {
  values: Record<string, { testCode: string; value: string }>;
};
const values = new Map(Object.values(staged.values).map((v) => [v.testCode, v.value]));

const raw = (await hmis.getPending({ sampleId: BARCODE, eqCode: an.equipmentCode })) as { data?: unknown[] };
const rows = (raw.data ?? []) as Array<Record<string, unknown>>;
console.log(`HMIS pending rows for ${BARCODE}: ${rows.length}`);
if (rows.length === 0) process.exit(1);
const rowByIdent = new Map(rows.map((r) => [String(r.eqIdntifier), r]));
const anyRow = rows[0]!;

const upload = [];
const skipped: string[] = [];
for (const code of an.allowTestCodes) {
  const value = values.get(code);
  if (value === undefined) { skipped.push(`${code} (no value from instrument)`); continue; }
  let parameterId: number; let identifier: string; let base: Record<string, unknown>;
  if (code in BY_IDENTIFIER) {
    const r = rowByIdent.get(BY_IDENTIFIER[code]!);
    if (!r) { skipped.push(`${code} (HMIS offers no row "${BY_IDENTIFIER[code]}")`); continue; }
    parameterId = Number(r.parameterId); identifier = String(r.eqIdntifier); base = r;
  } else if (code in BY_PARAMETER_ID) {
    parameterId = BY_PARAMETER_ID[code]!; identifier = code; base = anyRow;
  } else { skipped.push(`${code} (no mapping)`); continue; }
  upload.push({
    sampleId: BARCODE,
    labServiceId: Number(base.labServiceId),
    labResultId: Number(base.labResultId),
    equipmentId: an.equipmentId ?? (base.equipmentId as number),
    ipAddress: (an.transport as { host?: string }).host ?? '',
    portNo: String((an.transport as { port?: number }).port ?? ''),
    identifier,
    resultValue: value,
    isLoaded: false,
    uniqueIdentifier: identifier,
    parameterId,
  });
}
console.log(`\nSending ${upload.length} rows:`);
for (const u of upload) console.log(`  ${u.identifier.padEnd(28)} paramId ${String(u.parameterId).padStart(5)}  = ${u.resultValue}`);
if (skipped.length) console.log('Skipped:', skipped.join('; '));

try {
  const res = await hmis.postResults(upload, an.equipmentCode);
  console.log(`\nHMIS status: ${res.status} | message: ${res.message} | accepted ${res.successData.length} of ${upload.length}`);
  const ok = new Set(res.successData.map((s) => (s as { parameterId?: number }).parameterId));
  for (const u of upload) console.log(`  ${ok.has(u.parameterId) ? 'OK ' : '-- '} ${u.identifier.padEnd(28)} ${u.parameterId}`);
} catch (e) {
  console.log('\nHMIS REJECTED:', (e as Error).message);
}
