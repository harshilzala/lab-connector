// One-off: post a few Maglumi results (taken from live HINAI's audit log,
// lab-conector-deploy/logs/hmis-2026-11-03.*.log) to Tatva v1 preprod through
// the connector's own TatvaEquipmentClient. Results only — no acknowledge.
// Every call is recorded in logs/hmis-tatva-YYYY-MM-DD.log.
//
//   Run:  npx tsx scripts/push-tatva-test.ts
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { HmisAudit } from '../src/hmis/audit.js';
import { makeTatvaClient, tatvaClientOptions, tatvaEquipmentOptions } from '../src/hmis/tatva.js';
import { TatvaEquipmentClient } from '../src/hmis/tatva-equipment.js';
import { logger } from '../src/logger.js';

const SAMPLES: Array<{ sampleId: string; identifier: string; resultValue: string }> = [
  { sampleId: 'LB2611030490', identifier: 'B2-GP1 IgG', resultValue: '1.41' },
  { sampleId: 'LB2611030490', identifier: 'B2-GP1 IgM', resultValue: '0.521' },
  { sampleId: 'LB2611030518', identifier: 'DHEA-S II', resultValue: '64.9' },
  { sampleId: 'LB2611030518', identifier: 'AMH II', resultValue: '<0.007' },
  { sampleId: 'ZC2611030053', identifier: 'tTG IgA', resultValue: '>400' },
  { sampleId: 'LB2611030633', identifier: 'tTG IgA', resultValue: '<0.5' },
  { sampleId: 'LB2611030770', identifier: 'Anti-TPO II', resultValue: '639' },
  { sampleId: 'LB2611030770', identifier: 'Anti-Tg II', resultValue: '144' },
  { sampleId: 'LB2611030391', identifier: 'TRAb II', resultValue: '20.3' },
];

const root = resolve(import.meta.dirname, '..');
const cfg = loadConfig(resolve(root, 'config.json'));
const an = cfg.analyzers.find((a) => a.id === 'maglumi');
if (!an) throw new Error('no analyzer "maglumi" in config.json');
const t = cfg.hmis.tatva;
const audit = t.auditLog ? new HmisAudit(resolve(root, t.auditLog), logger.child({ mod: 'tatva-audit' }), cfg.hmis.auditMaxBytes) : undefined;
const common = { timeoutMs: cfg.hmis.timeoutMs, tlsRejectUnauthorized: cfg.hmis.tlsRejectUnauthorized, logger, audit };

let client: { postResults: TatvaEquipmentClient['postResults'] };
if (t.auth === 'equipment') {
  if (!an.tatva?.equipmentId || !an.tatva.equipmentSecret) throw new Error('maglumi has no tatva.equipmentId / equipmentSecret');
  const opts = tatvaEquipmentOptions(t as never, { equipmentId: an.tatva.equipmentId, equipmentSecret: an.tatva.equipmentSecret }, common as never);
  client = new TatvaEquipmentClient(opts);
  console.log(`auth=equipment  POST ${opts.baseUrl}${opts.resultsPath}  equipmentId=${opts.equipmentId}`);
} else {
  if (!t.clientId || !t.clientSecret) throw new Error('hmis.tatva.auth "oauth" needs clientId / clientSecret (TATVA_CLIENT_ID / TATVA_CLIENT_SECRET)');
  const opts = tatvaClientOptions(t as never, common as never);
  client = makeTatvaClient(opts);
  console.log(`auth=oauth  POST ${opts.baseUrl}${opts.resultsPath}  clientId=${opts.clientId}  barcodeField=${opts.barcodeField}`);
}

// One call per sample, like the connector files them.
const ONLY = process.argv.slice(2).map((x) => x.toUpperCase());
const picked = ONLY.length ? SAMPLES.filter((s) => ONLY.includes(s.sampleId)) : SAMPLES;
const bySample = new Map<string, typeof SAMPLES>();
for (const s of picked) bySample.set(s.sampleId, [...(bySample.get(s.sampleId) ?? []), s]);

for (const [sampleId, rows] of bySample) {
  const lines = rows.map((r) => `${r.identifier}=${r.resultValue}`).join(', ');
  try {
    const res = await client.postResults(rows as never, an.equipmentCode);
    console.log(`OK    ${sampleId}  [${lines}]  filed=${res.filed}  unmatched=${JSON.stringify(res.unmatched ?? [])}  "${res.message}"`);
  } catch (err) {
    console.log(`FAIL  ${sampleId}  [${lines}]  ${(err as Error).message}`);
  }
}
