import { loadConfig } from '../src/config.js';
const cfg = loadConfig('./config.json');
for (const a of cfg.analyzers) {
  const t = a.transport as { type: string; mode?: string; host?: string; port?: number };
  console.log(
    `${a.id.padEnd(20)} ${a.equipmentCode.padEnd(10)} ${t.type}/${t.mode ?? '-'} ${t.host}:${t.port}` +
      `  qc.patientPrefixes=${JSON.stringify(a.qc.patientPrefixes)} qc.upload=${a.qc.upload}`,
  );
}
