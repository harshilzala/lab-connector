// =============================================================================
// config.sample.json — the configuration LIBRARY.
//
//   npm run config:sample                          scan this checkout
//   npm run config:sample -- D:\lab-deploy\deploy  ... and another folder / file
//   (LAB_DEPLOY_DIR and D:\lab-deploy\deploy are added when they exist)
//
// Every config file found (config*.json / *config*.json holding an `analyzers`
// array or an `hmis` block) is read as JSONC, and each analyzer block — live OR
// parked in a `//` comment — and each top-level setting is copied into
// config.sample.json, tagged with the file it came from. Identical blocks from
// several files are stored once with all their sources.
//
// The library is CUMULATIVE. Re-scanning a file replaces what that file said
// before; a machine that has since been deleted from it is kept, tagged
// "[removed]", so a block that once worked can always be found again. Files
// not scanned this run (another PC's deploy folder) keep their entries as-is.
//
// SECRETS NEVER REACH THE SAMPLE: any password / secret / api key / token /
// hmac value — and the user or client id sitting beside one — is written as ""
// with a comment, and user:pass@ is cut out of URLs and connect strings. Put
// the real values in the site's own config.json or .env.
// =============================================================================
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJsonc } from '../src/config.js';
import { PROFILE_LIBRARY } from '../src/profiles/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const SAMPLE_NAME = 'config.sample.json';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

export interface Variant {
  /** Where this exact block was seen: "config.json", "config.json [commented out]", "config.json [removed]". */
  from: string[];
  value: Json;
}
export interface Library {
  settings: Record<string, Variant[]>;
  analyzers: Record<string, Variant[]>;
}

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---- secrets ----------------------------------------------------------------

/** A key whose value is a credential. `tokenPath`, `apiKeyHeader`, `authFile`
 *  and the like name WHERE a secret goes, not the secret, so they stay. */
export function isSecretKey(key: string): boolean {
  if (/(path|url|header|file|field|ttl|timeout)$/i.test(key)) return false;
  return /pass(word|wd|phrase)?$|^pwd$|secret|api[-_]?key|token|hmac|private[-_]?key|credential/i.test(key);
}

/** The identity half of a credential pair — redacted only beside a secret. */
const isIdentityKey = (key: string) => /^(user|username|userid|login|clientid|client_id)$/i.test(key);

/** Cut user:pass@ out of a URL, and user/pass@ out of an Oracle connect string. */
function stripInlineCredentials(s: string): string {
  return s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1').replace(/^[^/@\s:]+\/[^/@\s]+@/, '');
}

export function redact(value: Json): Json {
  if (typeof value === 'string') return stripInlineCredentials(value);
  if (Array.isArray(value)) return value.map(redact);
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  const pairsWithSecret = keys.some((k) => isSecretKey(k) && !isObject(value[k]) && !Array.isArray(value[k]));
  const out: JsonObject = {};
  for (const k of keys) {
    const v = value[k]!;
    const scalar = !isObject(v) && !Array.isArray(v) && v !== null;
    if (scalar && (isSecretKey(k) || (pairsWithSecret && isIdentityKey(k)))) out[k] = '';
    else out[k] = redact(v);
  }
  return out;
}

// ---- reading a config file --------------------------------------------------

/** Move past the `{ ... }` that opens at `start`, honouring strings and comments. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Analyzer blocks parked in `//` comments — the "use this instead" alternatives
 *  and machines switched off by commenting them out. A run of comment lines
 *  (blank lines inside it included) is uncommented one level and every
 *  `{ "id": ...}` object in it that parses is returned. */
export function extractCommentedAnalyzers(text: string): JsonObject[] {
  const lines = text.split(/\r?\n/);
  const isComment = (l: string) => /^\s*\/\//.test(l);
  const found: JsonObject[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isComment(lines[i]!)) continue;
    const run: string[] = [];
    let j = i;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (isComment(l)) run.push(l.replace(/^\s*\/\/ ?/, ''));
      else if (!l.trim()) {
        let k = j + 1;
        while (k < lines.length && !lines[k]!.trim()) k++;
        if (k < lines.length && isComment(lines[k]!)) run.push('');
        else break;
      } else break;
    }
    i = j - 1;

    const body = run.join('\n');
    const opener = /\{\s*"id"\s*:/g;
    for (let m = opener.exec(body); m; m = opener.exec(body)) {
      const end = matchBrace(body, m.index);
      if (end === -1) break;
      try {
        const obj = parseJsonc(body.slice(m.index, end + 1));
        if (isObject(obj) && typeof obj.id === 'string' && ('equipmentCode' in obj || 'profile' in obj || 'transport' in obj)) {
          found.push(obj);
          opener.lastIndex = end + 1;
        }
      } catch {
        // prose that happens to contain { "id": — not a parked block
      }
    }
  }
  return found;
}

export interface Scanned {
  settings: Record<string, Json>;
  live: JsonObject[];
  commented: JsonObject[];
}

/** null when the file is not a lab-connector config. */
export function scanConfigText(text: string): Scanned | null {
  let doc: unknown;
  try {
    doc = parseJsonc(text);
  } catch {
    return null;
  }
  if (!isObject(doc) || !(Array.isArray(doc.analyzers) || isObject(doc.hmis) || isObject(doc.autoCertify))) return null;
  const settings: Record<string, Json> = {};
  for (const [k, v] of Object.entries(doc)) if (k !== 'analyzers') settings[k] = v;
  const live = (Array.isArray(doc.analyzers) ? doc.analyzers : []).filter(
    (a): a is JsonObject => isObject(a) && typeof a.id === 'string',
  );
  return { settings, live, commented: extractCommentedAnalyzers(text) };
}

// ---- the library ------------------------------------------------------------

const canonical = (v: Json): string =>
  JSON.stringify(v, (_k, val) =>
    isObject(val) ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]])) : val,
  );

const tagFile = (tag: string) => tag.replace(/ \[[^\]]+\]$/, '');
const tagRank = (tag: string) => (tag.endsWith('[removed]') ? 2 : tag.endsWith(']') ? 1 : 0);

function addVariant(list: Variant[], value: Json, tag: string): void {
  const key = canonical(value);
  const hit = list.find((v) => canonical(v.value) === key);
  if (!hit) list.push({ from: [tag], value });
  else if (!hit.from.includes(tag)) hit.from.push(tag);
}

/** Fold one scanned file into the library: what the file says now replaces
 *  what it said before; an entry it no longer has is kept as "[removed]". */
export function mergeSource(lib: Library, source: string, scan: Scanned): void {
  const fold = (section: Record<string, Variant[]>, current: Map<string, { value: Json; tag: string }[]>) => {
    for (const [name, variants] of Object.entries(section)) {
      for (const v of variants) {
        const mine = v.from.filter((t) => tagFile(t) === source);
        if (!mine.length) continue;
        v.from = v.from.filter((t) => tagFile(t) !== source);
        if (!current.has(name)) v.from.push(`${source} [removed]`);
      }
      section[name] = variants.filter((v) => v.from.length);
    }
    for (const [name, entries] of current) {
      const list = (section[name] ??= []);
      for (const e of entries) addVariant(list, redact(e.value), e.tag);
    }
  };

  const settings = new Map<string, { value: Json; tag: string }[]>();
  for (const [k, v] of Object.entries(scan.settings)) settings.set(k, [{ value: v, tag: source }]);
  fold(lib.settings, settings);

  const analyzers = new Map<string, { value: Json; tag: string }[]>();
  const put = (a: JsonObject, tag: string) => {
    const id = a.id as string;
    if (!analyzers.has(id)) analyzers.set(id, []);
    analyzers.get(id)!.push({ value: a, tag });
  };
  for (const a of scan.live) put(a, source);
  for (const a of scan.commented) put(a, `${source} [commented out]`);
  fold(lib.analyzers, analyzers);
}

// ---- writing it -------------------------------------------------------------

const INLINE_MAX = 110;
const isScalar = (v: Json) => v === null || typeof v !== 'object';

function render(value: Json, depth: number): string {
  if (isScalar(value)) return JSON.stringify(value);
  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const inline = `[${value.map((v) => render(v, 0)).join(', ')}]`;
    if (value.every(isScalar) && inline.length <= INLINE_MAX) return inline;
    return `[\n${value.map((v, i) => pad + render(v, depth + 1) + (i < value.length - 1 ? ',' : '')).join('\n')}\n${close}]`;
  }
  const keys = Object.keys(value);
  if (!keys.length) return '{}';
  const secrets = keys.filter((k) => isSecretKey(k) || isIdentityKey(k));
  const inline = `{ ${keys.map((k) => `${JSON.stringify(k)}: ${render(value[k]!, 0)}`).join(', ')} }`;
  if (!secrets.length && keys.every((k) => isScalar(value[k]!)) && inline.length <= INLINE_MAX) return inline;
  const rows = keys.map((k, i) => {
    const v = value[k]!;
    const comma = i < keys.length - 1 ? ',' : '';
    const note = isSecretKey(k) && v === '' ? '  // secret — set it in the site config.json or .env, never here' : '';
    return `${pad}${JSON.stringify(k)}: ${render(v, depth + 1)}${comma}${note}`;
  });
  return `{\n${rows.join('\n')}\n${close}}`;
}

const SETTING_ORDER = ['logLevel', 'sampleIdFormat', 'spoolDir', 'hmis', 'retention', 'admin', 'Force_Hmis', 'autoCertify'];

function renderSection(section: Record<string, Variant[]>, names: string[], body: 'value' | 'block'): string {
  const entries = names.map((name, i) => {
    const variants = [...section[name]!]
      .map((v) => ({ ...v, from: [...v.from].sort((a, b) => tagRank(a) - tagRank(b) || a.localeCompare(b)) }))
      .sort((a, b) => tagRank(a.from[0]!) - tagRank(b.from[0]!) || a.from[0]!.localeCompare(b.from[0]!));
    const rendered = variants.map(
      (v, j) =>
        `      {\n        "from": ${render(v.from, 4)},\n        "${body}": ${render(v.value, 4)}\n      }${j < variants.length - 1 ? ',' : ''}`,
    );
    return `    ${JSON.stringify(name)}: [\n${rendered.join('\n')}\n    ]${i < names.length - 1 ? ',' : ''}`;
  });
  return `{\n${entries.join('\n')}\n  }`;
}

export function renderSample(lib: Library): string {
  const settingNames = Object.keys(lib.settings).sort((a, b) => {
    const ia = SETTING_ORDER.indexOf(a);
    const ib = SETTING_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const analyzerNames = Object.keys(lib.analyzers).sort();
  const profiles = Object.fromEntries(
    Object.entries(PROFILE_LIBRARY).map(([name, p]) => [name, p.description]),
  ) as JsonObject;

  return `{
  // ===========================================================================
  // CONFIG LIBRARY — generated by \`npm run config:sample\`. Do not edit by hand;
  // edit a config.json and re-run it (npm run deploy also refreshes it).
  //
  // Every analyzer block and every top-level setting ever seen in a config file
  // — this checkout's, a deployment folder's, or one passed on the command
  // line — collected in one place. Each entry lists the files it came from:
  //
  //   "config.json"                    live in that file
  //   "config.json [commented out]"    parked in a // comment there
  //   "config.json [removed]"          was in that file, has since been deleted
  //
  // TO USE ONE: copy its "block" into the "analyzers" array of any config.json
  // (or a "value" in as that top-level key), then change what is specific to
  // the new site — id, equipmentCode, siteIds, the transport's host / port.
  //
  // SECRETS ARE NOT HERE. Passwords, client secrets, API keys, tokens and the
  // user / client id beside them are blank (""): fill them in the site's own
  // config.json, or better its .env (AUTOCERTIFY_ORACLE_PASSWORD,
  // GENX_CLIENT_ID, GENX_CLIENT_SECRET, GENX_API_KEY).
  //
  // "profiles" lists every instrument model the connector knows. A new machine
  // of a listed model needs no more than:
  //   { "id": "...", "profile": "<name>", "equipmentCode": "...",
  //     "transport": { "type": "tcp", "mode": "server", "host": "0.0.0.0", "port": <port> } }
  // ===========================================================================

  "profiles": ${render(profiles, 1)},

  "settings": ${renderSection(lib.settings, settingNames, 'value')},

  "analyzers": ${renderSection(lib.analyzers, analyzerNames, 'block')}
}
`;
}

/** The library inside an existing config.sample.json, or an empty one. */
export function readLibrary(text: string | null): Library {
  const lib: Library = { settings: {}, analyzers: {} };
  if (!text) return lib;
  const doc = parseJsonc(text);
  if (!isObject(doc)) return lib;
  for (const [section, body] of [['settings', 'value'], ['analyzers', 'block']] as const) {
    const s = doc[section];
    if (!isObject(s)) continue;
    for (const [name, list] of Object.entries(s)) {
      if (!Array.isArray(list)) continue;
      lib[section][name] = list
        .filter((v): v is JsonObject => isObject(v) && Array.isArray(v.from) && body in v)
        .map((v) => ({ from: (v.from as Json[]).map(String), value: redact(v[body]!) }));
    }
  }
  return lib;
}

// ---- finding the files ------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'logs', 'spool', 'spool-offline', '.pm2', 'captures', '.tokensave', 'dist', 'old-interface']);

function isConfigName(name: string): boolean {
  if (name === SAMPLE_NAME || /^(ts|js)config\.json$|^package(-lock)?\.json$/i.test(name)) return false;
  return /config.*\.jsonc?$/i.test(name);
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth < 0) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, depth - 1, out);
    } else if (e.isFile() && isConfigName(e.name)) out.push(p);
  }
}

function sourceLabel(file: string): string {
  const rel = relative(ROOT, file);
  const label = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file;
  return label.split(sep).join('/');
}

function main(): void {
  const args = process.argv.slice(2);
  const outArg = args.indexOf('--out');
  const out = outArg !== -1 && args[outArg + 1] ? resolve(args[outArg + 1]!) : join(ROOT, SAMPLE_NAME);
  const extra = args.filter((a, i) => !a.startsWith('--') && !(outArg !== -1 && i === outArg + 1));

  const roots = [ROOT, ...extra.map((a) => resolve(a))];
  for (const d of [process.env.LAB_DEPLOY_DIR, 'D:\\lab-deploy\\deploy']) {
    if (d && existsSync(d) && !roots.includes(resolve(d))) roots.push(resolve(d));
  }

  const files = new Set<string>();
  for (const r of roots) {
    if (!existsSync(r)) {
      console.warn(`  skipped ${r} — not found`);
      continue;
    }
    if (statSync(r).isFile()) files.add(r);
    else {
      const found: string[] = [];
      walk(r, 4, found);
      found.forEach((f) => files.add(f));
    }
  }

  const lib = readLibrary(existsSync(out) ? readFileSync(out, 'utf8') : null);
  for (const f of [...files].sort()) {
    const label = sourceLabel(f);
    const scan = scanConfigText(readFileSync(f, 'utf8'));
    if (!scan) {
      console.log(`  -  ${label}  (not a lab-connector config)`);
      continue;
    }
    mergeSource(lib, label, scan);
    const parked = scan.commented.length ? `, ${scan.commented.length} commented out` : '';
    console.log(`  +  ${label}  (${scan.live.length} analyzer(s)${parked}, ${Object.keys(scan.settings).length} setting(s))`);
  }

  writeFileSync(out, renderSample(lib));
  const n = (s: Record<string, Variant[]>) => Object.values(s).reduce((t, v) => t + v.length, 0);
  console.log(
    `\n  ${basename(out)}: ${Object.keys(lib.analyzers).length} machine(s) in ${n(lib.analyzers)} variant(s), ` +
      `${Object.keys(lib.settings).length} setting(s) in ${n(lib.settings)} variant(s) — secrets blanked\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
