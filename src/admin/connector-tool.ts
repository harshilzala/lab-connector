import { BASE_CSS, FONT_LINK } from './theme.js';

// =============================================================================
// CONNECTOR TOOL — the universal monitor.
//
// Served at GET /connector to an authenticated session. Three panels, in the
// order commissioning actually goes:
//
//   1. DISCOVER  Where is the machine? Sweep the lab VLAN for open ports, or
//                enumerate COM ports and sweep baud rates.
//   2. PROBE     Open a raw link with no codec bound, watch every byte, and
//                push bytes back by hand.
//   3. IDENTIFY  Score the capture against every protocol we know and, when it
//                is one this connector implements, emit the config.json block.
//
// Everything here is read-only with respect to the interface: a probe never
// files a result, never touches the spool and never talks to HMIS.
// =============================================================================

export interface ConnectorToolOptions {
  username: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const PAGE_CSS = `
body { display:flex; flex-direction:column; min-height:100vh; }

.topbar { position:sticky; top:0; z-index:10; background:#fff; border-bottom:1px solid var(--line); box-shadow:0 1px 3px rgba(54,50,50,.04); }
.topbar-inner { max-width:1240px; margin:0 auto; padding:12px 24px; display:flex; align-items:center; gap:18px; }
.brand { display:flex; align-items:center; gap:14px; min-width:0; }
.brand .divider { width:1px; height:34px; background:var(--line); }
.brand h1 { font-size:17px; letter-spacing:-.2px; }
.brand .sub { font-size:12px; color:var(--mut); font-weight:600; letter-spacing:.3px; text-transform:uppercase; }
.brand img.logo { height:30px; }
.spacer { flex:1; }
.topbar .tools { display:flex; align-items:center; gap:10px; }
.who { display:flex; align-items:center; gap:8px; padding:5px 12px 5px 6px; background:var(--teal-soft); border-radius:999px; font-size:13px; font-weight:700; color:var(--teal-700); }
.who .avatar { width:26px; height:26px; border-radius:50%; display:grid; place-items:center; background:var(--teal); color:#fff; font-size:12px; font-weight:800; }

main { flex:1; width:100%; max-width:1240px; margin:0 auto; padding:26px 24px 40px; }

.btn { border:0; cursor:pointer; font:800 13px/1 var(--font); padding:10px 16px; border-radius:9px; background:var(--teal); color:#fff; transition:background .15s; }
.btn:hover { background:var(--teal-600); }
.btn[disabled] { opacity:.5; cursor:not-allowed; }
.btn-ghost { background:#fff; color:var(--body); border:1px solid var(--line); }
.btn-ghost:hover { background:#fbfbfc; color:var(--teal-700); border-color:var(--teal-700); }
.btn-plum { background:var(--plum); } .btn-plum:hover { background:var(--plum-600); }
.btn-danger { background:var(--bad); } .btn-danger:hover { background:#b93232; }
.btn-sm { padding:6px 11px; font-size:12px; border-radius:7px; }

/* ---- steps ---- */
.steps { display:flex; gap:0; margin:0 0 24px; border:1px solid var(--line); border-radius:var(--radius); overflow:hidden; background:#fff; box-shadow:var(--shadow); }
.step { flex:1; padding:14px 18px; border-right:1px solid var(--line); display:flex; gap:12px; align-items:flex-start; }
.step:last-child { border-right:0; }
.step .n { width:26px; height:26px; flex:0 0 26px; border-radius:50%; display:grid; place-items:center; background:var(--line); color:var(--mut); font-weight:800; font-size:12px; }
.step.on .n { background:var(--teal); color:#fff; }
.step .t { font-weight:800; color:var(--ink); font-size:13.5px; }
.step .d { font-size:12.5px; color:var(--mut); margin-top:2px; line-height:1.45; }

.panel { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); margin:0 0 22px; overflow:hidden; }
.panel-top { padding:15px 18px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.panel-top h2 { font-size:15px; }
.panel-top .hint { font-size:12.5px; color:var(--mut); }
.panel-body { padding:16px 18px 18px; }

.row { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; }
.f { display:flex; flex-direction:column; gap:5px; }
.f label { font-size:11.5px; font-weight:800; letter-spacing:.5px; text-transform:uppercase; color:var(--mut); }
.f input, .f select, .f textarea {
  font:400 14px/1.4 var(--font); color:var(--ink); background:#fff;
  border:1px solid var(--line); border-radius:9px; padding:9px 11px; min-width:130px;
}
.f input:focus, .f select:focus, .f textarea:focus { outline:2px solid var(--teal-soft); border-color:var(--teal); }
.f.grow { flex:1; min-width:240px; }
.f.grow input, .f.grow textarea { width:100%; }
.f .note { font-size:11.5px; color:var(--mut); font-weight:400; text-transform:none; letter-spacing:0; }
label.chk { display:flex; align-items:center; gap:7px; font-size:13.5px; color:var(--body); font-weight:600; padding-bottom:9px; }

.mono { font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace; }

/* ---- live wire view ---- */
.wire { background:#1c1a1a; color:#e8e5e5; border-radius:10px; padding:12px 14px; height:340px; overflow:auto; font:12.5px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace; }
.wire .l { display:flex; gap:10px; white-space:pre-wrap; word-break:break-all; border-bottom:1px solid #2b2828; padding:2px 0; }
.wire .ts { color:#7d7676; flex:0 0 auto; }
.wire .dir { flex:0 0 34px; font-weight:800; }
.wire .IN  .dir { color:#4fd1a5; } .wire .OUT .dir { color:#f0a95c; } .wire .SYS .dir { color:#8fa8d9; }
.wire .empty { color:#7d7676; }

.badge { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border-radius:999px; font-size:11.5px; font-weight:800; letter-spacing:.3px; }
.badge.ok { background:var(--ok-soft); color:var(--ok); }
.badge.idle { background:var(--line); color:var(--mut); }
.badge.warn { background:var(--warn-soft); color:var(--warn); }
.badge.bad { background:var(--bad-soft); color:var(--bad); }
.dot { width:7px; height:7px; border-radius:50%; background:currentColor; }

.stats { display:flex; gap:22px; flex-wrap:wrap; margin-top:14px; }
.stats .s .k { font-size:11px; font-weight:800; letter-spacing:.5px; text-transform:uppercase; color:var(--mut); }
.stats .s .v { font-size:19px; font-weight:800; color:var(--ink); font-variant-numeric:tabular-nums; }

table { width:100%; border-collapse:collapse; font-size:13.5px; }
th { text-align:left; font-size:11px; letter-spacing:.5px; text-transform:uppercase; color:var(--mut); padding:8px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
td { padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
tr:last-child td { border-bottom:0; }
td.mono { font-size:12.5px; word-break:break-all; }

/* ---- identify results ---- */
.cand { border:1px solid var(--line); border-radius:11px; padding:14px 16px; margin-bottom:12px; }
.cand.top { border-color:var(--teal); background:var(--teal-soft); }
.cand-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.cand-head .nm { font-weight:800; color:var(--ink); font-size:14.5px; }
.bar { flex:1; min-width:120px; height:7px; border-radius:4px; background:var(--line); overflow:hidden; }
.bar i { display:block; height:100%; background:var(--teal); }
.cand.top .bar { background:#fff; }
.pc { font-weight:800; font-variant-numeric:tabular-nums; color:var(--teal-700); font-size:13.5px; }
.cand ul { margin:10px 0 0; padding-left:20px; font-size:13px; color:var(--body); }
.cand li { margin:3px 0; }
.pill { display:inline-block; padding:2px 9px; border-radius:6px; font-size:11px; font-weight:800; letter-spacing:.3px; }
.pill.sup { background:var(--ok-soft); color:var(--ok); }
.pill.uns { background:var(--plum-soft); color:var(--plum-600); }

pre.cfg { background:#1c1a1a; color:#e8e5e5; border-radius:10px; padding:14px 16px; overflow:auto; font:12.5px/1.6 ui-monospace,Consolas,monospace; margin:12px 0 0; max-height:420px; }

.msg { padding:12px 15px; border-radius:10px; font-size:13.5px; margin:0 0 16px; }
.msg.info { background:var(--teal-soft); color:var(--teal-700); }
.msg.warn { background:var(--warn-soft); color:var(--warn); }
.msg.bad  { background:var(--bad-soft); color:var(--bad); }
.msg.ok   { background:var(--ok-soft); color:var(--ok); }

.mut { color:var(--mut); font-size:13px; }
.hidden { display:none !important; }
.pagefoot { text-align:center; padding:22px; color:var(--mut); font-size:12.5px; border-top:1px solid var(--line); }
.proto-fam { margin-top:14px; }
.proto-fam h4 { font-size:12px; font-weight:800; letter-spacing:.4px; text-transform:uppercase; color:var(--plum-600); margin:0 0 7px; }
.proto-list { display:flex; flex-wrap:wrap; gap:7px; }
.proto-list span { font-size:12px; padding:4px 10px; border-radius:7px; background:var(--bg); border:1px solid var(--line); color:var(--body); }
.proto-list span.sup { border-color:var(--ok); color:var(--ok); font-weight:700; }
.fam-chip { display:inline-block; padding:2px 9px; border-radius:6px; font-size:11px; font-weight:800; letter-spacing:.3px; background:var(--plum-soft); color:var(--plum-600); }

@media (max-width:900px) { .steps { flex-direction:column; } .step { border-right:0; border-bottom:1px solid var(--line); } }
`;

export function renderConnectorTool(o: ConnectorToolOptions): string {
  const initial = esc((o.username[0] ?? 'A').toUpperCase());

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Connector Tool &middot; Lab Connector</title>
${FONT_LINK}
<style>${BASE_CSS}${PAGE_CSS}</style>
</head>
<body>
<div class="brandbar"></div>

<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <img class="logo" src="/assets/zydus-logo.svg" alt="Zydus Hospitals" />
      <span class="divider"></span>
      <div>
        <div class="sub">HMIS Interface</div>
        <h1>Connector Tool</h1>
      </div>
    </div>
    <div class="spacer"></div>
    <div class="tools">
      <a class="btn btn-ghost btn-sm" href="/">&larr; Dashboard</a>
      <span class="who"><span class="avatar">${initial}</span>${esc(o.username)}</span>
      <form method="post" action="/logout" style="margin:0">
        <button class="btn btn-ghost btn-sm" type="submit">Sign out</button>
      </form>
    </div>
  </div>
</header>

<main>
  <div class="msg info">
    <strong>Universal device monitor.</strong>
    Connect an unknown analyzer, watch its raw traffic with no protocol assumed, and let the
    fingerprinter tell you what it is speaking. Nothing here files a result, touches the spool
    or contacts HMIS &mdash; it is a listening tool.
  </div>

  <div class="steps">
    <div class="step on"><div class="n">1</div><div><div class="t">Discover</div>
      <div class="d">Sweep the lab network for open analyzer ports, or list COM ports and find the baud rate.</div></div></div>
    <div class="step on"><div class="n">2</div><div><div class="t">Probe</div>
      <div class="d">Open the link with no codec bound. Every byte is recorded; you can send bytes back by hand.</div></div></div>
    <div class="step on"><div class="n">3</div><div><div class="t">Identify</div>
      <div class="d">Score the capture against every known protocol and get the config.json block to add the machine.</div></div></div>
  </div>

  <div id="alert"></div>

  <!-- ==================== 1. DISCOVER ==================== -->
  <section class="panel">
    <div class="panel-top">
      <h2>1 &middot; Discover</h2>
      <span class="hint">Read-only. A TCP probe opens a socket and closes it; a serial probe only listens.</span>
    </div>
    <div class="panel-body">
      <div class="row">
        <div class="f grow">
          <label for="scanHost">Host, range or CIDR</label>
          <input id="scanHost" value="127.0.0.1" placeholder="10.12.19.42 &middot; 10.12.19.1-254 &middot; 10.12.19.0/24" />
          <span class="note">A range sweeps every address in it. /22 is the widest allowed.</span>
        </div>
        <div class="f grow">
          <label for="scanPorts">Ports</label>
          <input id="scanPorts" placeholder="blank = the built-in analyzer port list" />
          <span class="note">Comma-separated, or ranges like 5000-5010.</span>
        </div>
        <div class="f">
          <label for="scanTimeout">Connect timeout</label>
          <input id="scanTimeout" type="number" value="700" min="100" max="5000" style="width:110px" />
        </div>
        <div class="f"><label>&nbsp;</label>
          <button class="btn" id="btnScan" onclick="scanTcp()">Scan network</button></div>
      </div>

      <div id="scanOut" style="margin-top:16px"></div>

      <hr style="border:0;border-top:1px solid var(--line);margin:20px 0" />

      <div class="row">
        <div class="f"><label>&nbsp;</label>
          <button class="btn btn-ghost" onclick="listSerial()">List COM ports</button></div>
        <div class="f grow">
          <label for="sweepPath">Baud-rate sweep on</label>
          <input id="sweepPath" placeholder="COM3" />
          <span class="note">Start the analyzer transmitting first &mdash; a silent port tells the sweep nothing.</span>
        </div>
        <div class="f">
          <label for="sweepMs">Listen per rate</label>
          <input id="sweepMs" type="number" value="3000" min="500" max="15000" style="width:120px" />
        </div>
        <div class="f"><label>&nbsp;</label>
          <button class="btn btn-plum" id="btnSweep" onclick="sweepBaud()">Sweep baud rates</button></div>
      </div>
      <div id="serialOut" style="margin-top:16px"></div>
    </div>
  </section>

  <!-- ==================== 2. PROBE ==================== -->
  <section class="panel">
    <div class="panel-top">
      <h2>2 &middot; Probe</h2>
      <span id="probeBadge" class="badge idle"><span class="dot"></span>stopped</span>
      <span class="hint" id="probeEndpoint"></span>
      <div class="spacer"></div>
      <button class="btn btn-ghost btn-sm" onclick="clearProbe()">Clear capture</button>
      <button class="btn btn-ghost btn-sm" onclick="saveProbe()">Save to captures/</button>
    </div>
    <div class="panel-body">
      <div class="row">
        <div class="f">
          <label for="pType">Link</label>
          <select id="pType" onchange="onTypeChange()">
            <option value="tcp">TCP</option>
            <option value="serial">Serial (RS-232)</option>
          </select>
        </div>

        <div class="tcpOnly f">
          <label for="pMode">Direction</label>
          <select id="pMode">
            <option value="server">Listen &mdash; the device dials us</option>
            <option value="client">Connect &mdash; we dial the device</option>
          </select>
        </div>
        <div class="tcpOnly f"><label for="pHost">Host / bind</label><input id="pHost" value="0.0.0.0" /></div>
        <div class="tcpOnly f"><label for="pPort">Port</label><input id="pPort" type="number" value="5001" style="width:110px" /></div>

        <div class="serialOnly f hidden"><label for="pPath">Port</label><input id="pPath" placeholder="COM3" style="width:120px" /></div>
        <div class="serialOnly f hidden"><label for="pBaud">Baud</label>
          <select id="pBaud">
            <option>9600</option><option>19200</option><option>38400</option><option>115200</option>
            <option>4800</option><option>57600</option><option>2400</option><option>1200</option>
          </select></div>
        <div class="serialOnly f hidden"><label for="pBits">Data</label>
          <select id="pBits"><option>8</option><option>7</option><option>6</option><option>5</option></select></div>
        <div class="serialOnly f hidden"><label for="pStop">Stop</label>
          <select id="pStop"><option>1</option><option>2</option></select></div>
        <div class="serialOnly f hidden"><label for="pParity">Parity</label>
          <select id="pParity"><option>none</option><option>even</option><option>odd</option><option>mark</option><option>space</option></select></div>
        <div class="serialOnly hidden"><label class="chk"><input type="checkbox" id="pDtr" checked /> DTR</label></div>
        <div class="serialOnly hidden"><label class="chk"><input type="checkbox" id="pRts" checked /> RTS</label></div>

        <div><label class="chk"><input type="checkbox" id="pAck" checked /> Auto-answer handshakes</label></div>

        <div class="f"><label>&nbsp;</label>
          <button class="btn" id="btnStart" onclick="startProbe()">Start probe</button></div>
        <div class="f"><label>&nbsp;</label>
          <button class="btn btn-danger" id="btnStop" onclick="stopProbe()" disabled>Stop</button></div>
      </div>

      <p class="mut" style="margin:12px 0 0">
        <strong>Auto-answer</strong> plays a minimal, protocol-neutral receiver: it ACKs an ASTM ENQ and each
        frame, and returns an <span class="mono">MSA|AA</span> to an HL7 MLLP block. Without it most analyzers
        wait for a reply that never comes and abandon the transmission, so the capture is one byte long.
        It never interprets, files or forwards anything.
      </p>

      <div class="stats">
        <div class="s"><div class="k">Bytes in</div><div class="v" id="sIn">0</div></div>
        <div class="s"><div class="k">Bytes out</div><div class="v" id="sOut">0</div></div>
        <div class="s"><div class="k">Peer</div><div class="v" id="sPeer">&mdash;</div></div>
        <div class="s"><div class="k">Last activity</div><div class="v" id="sLast">&mdash;</div></div>
      </div>

      <div class="wire" id="wire" style="margin-top:14px"><div class="empty">No traffic captured yet.</div></div>

      <div class="row" style="margin-top:14px">
        <div class="f grow">
          <label for="txData">Send bytes to the device</label>
          <input id="txData" class="mono" placeholder="&lt;ENQ&gt;  &middot;  H|\\^&amp;  &middot;  \\x05" onkeydown="if(event.key==='Enter')sendBytes()" />
          <span class="note">Text mode understands <span class="mono">&lt;ENQ&gt; &lt;STX&gt; &lt;0D&gt;</span> mnemonics and <span class="mono">\\r \\n \\xNN</span> escapes.</span>
        </div>
        <div class="f">
          <label for="txMode">As</label>
          <select id="txMode"><option value="text">Text</option><option value="hex">Hex</option></select>
        </div>
        <div class="f"><label>&nbsp;</label><button class="btn btn-ghost" onclick="sendBytes()">Send</button></div>
      </div>
    </div>
  </section>

  <!-- ==================== 3. IDENTIFY ==================== -->
  <section class="panel">
    <div class="panel-top">
      <h2>3 &middot; Identify</h2>
      <span class="hint">Scores the capture against every protocol below. Paste a capture instead if you have one.</span>
      <div class="spacer"></div>
      <button class="btn btn-plum" onclick="analyzeCapture()">Analyse capture</button>
    </div>
    <div class="panel-body">
      <div class="row">
        <div class="f grow">
          <label for="pasteData">Analyse pasted data instead</label>
          <textarea id="pasteData" class="mono" rows="3" placeholder="Paste a wire-log line, a hex dump, or raw text captured elsewhere"></textarea>
        </div>
        <div class="f">
          <label for="pasteMode">As</label>
          <select id="pasteMode"><option value="text">Text</option><option value="hex">Hex</option></select>
        </div>
        <div class="f"><label>&nbsp;</label><button class="btn btn-ghost" onclick="analyzePasted()">Analyse paste</button></div>
      </div>

      <div id="identOut" style="margin-top:18px"><p class="mut">Run a probe or paste a capture, then analyse.</p></div>

      <div style="margin-top:20px">
        <div class="k" style="font-size:11.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--mut)">Protocols the fingerprinter knows</div>
        <div id="protoList"></div>
        <p class="mut" style="margin-top:10px">
          Green entries are protocols this connector already speaks &mdash; identifying one produces a
          ready-to-paste <span class="mono">config.json</span> block. The rest are recognised but not yet
          implemented; the evidence tells you what a new codec would have to handle.
        </p>
      </div>
    </div>
  </section>
</main>

<footer class="pagefoot">Zydus Hospitals &middot; HMIS Lab Connector &middot; Connector Tool</footer>

<script>
const $ = (id) => document.getElementById(id);
const escHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function note(kind, text) {
  $('alert').innerHTML = '<div class="msg ' + kind + '">' + escHtml(text) + '</div>';
  if (kind === 'ok' || kind === 'info') setTimeout(() => { $('alert').innerHTML = ''; }, 6000);
}

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, opts || {}));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
}

// ---- 1. Discover -----------------------------------------------------------
function parsePorts(s) {
  const t = (s || '').trim();
  if (!t) return null;
  const out = [];
  for (const part of t.split(',')) {
    const m = /^\\s*(\\d+)\\s*-\\s*(\\d+)\\s*$/.exec(part);
    if (m) { for (let p = +m[1]; p <= +m[2]; p++) out.push(p); }
    else if (part.trim()) out.push(+part.trim());
  }
  return out.filter(p => p > 0 && p < 65536);
}

async function scanTcp() {
  const btn = $('btnScan'); btn.disabled = true; btn.textContent = 'Scanning…';
  $('scanOut').innerHTML = '<p class="mut">Sweeping…</p>';
  try {
    const body = { host: $('scanHost').value.trim(), connectTimeoutMs: +$('scanTimeout').value || 700 };
    const ports = parsePorts($('scanPorts').value);
    if (ports && ports.length) body.ports = ports;
    const r = await api('/api/connector/scan', { method: 'POST', body: JSON.stringify(body) });
    if (!r.hits.length) {
      $('scanOut').innerHTML = '<p class="mut">Nothing answered on ' + r.scanned + ' probes (' +
        (r.elapsedMs/1000).toFixed(1) + 's). Widen the port list, or check the analyzer is powered and cabled.</p>';
      return;
    }
    $('scanOut').innerHTML =
      '<p class="mut" style="margin:0 0 8px">' + r.hits.length + ' open of ' + r.scanned + ' probes in ' +
      (r.elapsedMs/1000).toFixed(1) + 's</p>' +
      '<table><thead><tr><th>Host</th><th>Port</th><th>Latency</th><th>Probably</th><th>Greeting</th><th></th></tr></thead><tbody>' +
      r.hits.map(h =>
        '<tr><td class="mono">' + escHtml(h.host) + '</td><td class="mono">' + h.port + '</td>' +
        '<td class="mono">' + h.latencyMs + ' ms</td>' +
        '<td>' + (h.guess ? escHtml(h.guess) : '<span class="mut">unknown</span>') + '</td>' +
        '<td class="mono">' + (h.banner ? escHtml(h.banner) : '<span class="mut">silent</span>') + '</td>' +
        '<td><button class="btn btn-ghost btn-sm" onclick="useTarget(\\'' + escHtml(h.host) + '\\',' + h.port + ')">Probe this</button></td></tr>'
      ).join('') + '</tbody></table>';
  } catch (e) { $('scanOut').innerHTML = ''; note('bad', e.message); }
  finally { btn.disabled = false; btn.textContent = 'Scan network'; }
}

function useTarget(host, port) {
  $('pType').value = 'tcp'; onTypeChange();
  $('pMode').value = 'client'; $('pHost').value = host; $('pPort').value = port;
  $('pHost').scrollIntoView({ behavior: 'smooth', block: 'center' });
  note('info', 'Probe set to dial ' + host + ':' + port + '. Press Start probe.');
}

async function listSerial() {
  $('serialOut').innerHTML = '<p class="mut">Enumerating…</p>';
  try {
    const r = await api('/api/connector/serial');
    if (r.error) { $('serialOut').innerHTML = '<div class="msg warn">' + escHtml(r.error) + '</div>'; return; }
    if (!r.ports.length) { $('serialOut').innerHTML = '<p class="mut">No serial ports on this PC.</p>'; return; }
    $('serialOut').innerHTML =
      '<table><thead><tr><th>Port</th><th>Manufacturer</th><th>Vendor / product</th><th>Serial</th><th></th></tr></thead><tbody>' +
      r.ports.map(p =>
        '<tr><td class="mono">' + escHtml(p.path) + '</td>' +
        '<td>' + escHtml(p.manufacturer || p.friendlyName || '—') + '</td>' +
        '<td class="mono">' + escHtml([p.vendorId, p.productId].filter(Boolean).join(':') || '—') + '</td>' +
        '<td class="mono">' + escHtml(p.serialNumber || '—') + '</td>' +
        '<td><button class="btn btn-ghost btn-sm" onclick="useSerial(\\'' + escHtml(p.path) + '\\')">Use this</button></td></tr>'
      ).join('') + '</tbody></table>';
  } catch (e) { $('serialOut').innerHTML = ''; note('bad', e.message); }
}

function useSerial(path) {
  $('sweepPath').value = path;
  $('pType').value = 'serial'; onTypeChange(); $('pPath').value = path;
  note('info', path + ' selected. Sweep the baud rate, or start the probe directly.');
}

async function sweepBaud() {
  const path = $('sweepPath').value.trim();
  if (!path) return note('warn', 'Name the COM port to sweep.');
  const btn = $('btnSweep'); btn.disabled = true; btn.textContent = 'Sweeping…';
  $('serialOut').innerHTML = '<p class="mut">Listening at each rate — this takes a while by design.</p>';
  try {
    const r = await api('/api/connector/serial/sweep', {
      method: 'POST', body: JSON.stringify({ path, listenMsPerRate: +$('sweepMs').value || 3000 }),
    });
    if (r.error) { $('serialOut').innerHTML = '<div class="msg warn">' + escHtml(r.error) + '</div>'; return; }
    $('serialOut').innerHTML =
      (r.best
        ? '<div class="msg ok"><strong>' + r.best.baudRate + ' baud</strong> is the best fit — ' +
          r.best.bytes + ' bytes, ' + Math.round(r.best.printableRatio * 100) + '% printable.</div>'
        : '<div class="msg warn">Nothing arrived at any rate. Is the analyzer transmitting?</div>') +
      '<table><thead><tr><th>Baud</th><th>Bytes</th><th>Printable</th><th>Sample</th></tr></thead><tbody>' +
      r.trials.map(t =>
        '<tr><td class="mono">' + t.baudRate + '</td><td class="mono">' + t.bytes + '</td>' +
        '<td class="mono">' + Math.round(t.printableRatio * 100) + '%</td>' +
        '<td class="mono">' + (t.sample ? escHtml(t.sample.slice(0, 120)) : '<span class="mut">—</span>') + '</td></tr>'
      ).join('') + '</tbody></table>';
    if (r.best) { $('pBaud').value = String(r.best.baudRate); $('pPath').value = path; }
  } catch (e) { $('serialOut').innerHTML = ''; note('bad', e.message); }
  finally { btn.disabled = false; btn.textContent = 'Sweep baud rates'; }
}

// ---- 2. Probe --------------------------------------------------------------
function onTypeChange() {
  const tcp = $('pType').value === 'tcp';
  document.querySelectorAll('.tcpOnly').forEach(e => e.classList.toggle('hidden', !tcp));
  document.querySelectorAll('.serialOnly').forEach(e => e.classList.toggle('hidden', tcp));
}

function transportBody() {
  if ($('pType').value === 'tcp') {
    return { type: 'tcp', mode: $('pMode').value, host: $('pHost').value.trim(), port: +$('pPort').value };
  }
  return {
    type: 'serial', path: $('pPath').value.trim(), baudRate: +$('pBaud').value,
    dataBits: +$('pBits').value, stopBits: +$('pStop').value, parity: $('pParity').value,
    dtr: $('pDtr').checked, rts: $('pRts').checked,
  };
}

async function startProbe() {
  try {
    await api('/api/connector/probe/start', {
      method: 'POST',
      body: JSON.stringify({ transport: transportBody(), autoAck: $('pAck').checked }),
    });
    note('ok', 'Probe running. Trigger a transmission on the analyzer.');
    poll();
  } catch (e) { note('bad', e.message); }
}

async function stopProbe() {
  try { await api('/api/connector/probe/stop', { method: 'POST' }); note('info', 'Probe stopped. The capture is kept.'); poll(); }
  catch (e) { note('bad', e.message); }
}

async function clearProbe() {
  try { await api('/api/connector/probe/clear', { method: 'POST' }); poll(); }
  catch (e) { note('bad', e.message); }
}

async function saveProbe() {
  try { const r = await api('/api/connector/probe/save', { method: 'POST' });
    note('ok', 'Saved ' + r.bytes + ' bytes to ' + r.bin); }
  catch (e) { note('bad', e.message); }
}

async function sendBytes() {
  const data = $('txData').value;
  if (!data) return;
  try {
    await api('/api/connector/probe/send', { method: 'POST', body: JSON.stringify({ data, mode: $('txMode').value }) });
    $('txData').value = '';
    poll();
  } catch (e) { note('bad', e.message); }
}

let lastCount = 0;
function renderState(s, log) {
  const b = $('probeBadge');
  if (!s.running) { b.className = 'badge idle'; b.innerHTML = '<span class="dot"></span>stopped'; }
  else if (s.error) { b.className = 'badge bad'; b.innerHTML = '<span class="dot"></span>error'; }
  else if (s.connected) { b.className = 'badge ok'; b.innerHTML = '<span class="dot"></span>device connected'; }
  else { b.className = 'badge warn'; b.innerHTML = '<span class="dot"></span>waiting for device'; }

  $('probeEndpoint').textContent = s.running ? s.endpoint + (s.error ? ' — ' + s.error : '') : '';
  $('btnStart').disabled = !!s.running;
  $('btnStop').disabled = !s.running;
  $('sIn').textContent = s.bytesIn;
  $('sOut').textContent = s.bytesOut;
  $('sPeer').textContent = s.connected ? 'connected' : (s.running ? 'waiting' : '—');
  $('sLast').textContent = s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleTimeString() : '—';

  const w = $('wire');
  if (!log.length) { w.innerHTML = '<div class="empty">No traffic captured yet.</div>'; lastCount = 0; return; }
  if (log.length === lastCount) return;
  const stick = w.scrollTop + w.clientHeight >= w.scrollHeight - 24;
  w.innerHTML = log.map(e =>
    '<div class="l ' + e.direction + '"><span class="ts">' + new Date(e.at).toLocaleTimeString() + '</span>' +
    '<span class="dir">' + e.direction + '</span><span>' + escHtml(e.text) + '</span></div>').join('');
  lastCount = log.length;
  if (stick) w.scrollTop = w.scrollHeight;
}

async function poll() {
  try { const r = await api('/api/connector/probe'); renderState(r.state, r.log); }
  catch (e) { /* the page stays usable while the probe is between states */ }
}

// ---- 3. Identify -----------------------------------------------------------
function renderIdentify(r) {
  if (!r.candidates.length) {
    $('identOut').innerHTML =
      '<div class="msg warn">Nothing recognisable in ' + r.bytes + ' bytes.</div>' + observations(r);
    return;
  }
  const cands = r.candidates.map((c, i) =>
    '<div class="cand' + (i === 0 ? ' top' : '') + '">' +
      '<div class="cand-head">' +
        '<span class="nm">' + escHtml(c.name) + '</span>' +
        '<span class="fam-chip">' + escHtml(FAMILIES[c.family] || c.family) + '</span>' +
        '<span class="pill ' + (c.supported ? 'sup' : 'uns') + '">' +
          (c.supported ? 'supported &middot; protocol: ' + escHtml(c.supported) : 'not implemented') + '</span>' +
        '<span class="bar"><i style="width:' + Math.round(c.confidence * 100) + '%"></i></span>' +
        '<span class="pc">' + Math.round(c.confidence * 100) + '%</span>' +
      '</div>' +
      '<ul>' + c.evidence.map(e => '<li>' + escHtml(e) + '</li>').join('') + '</ul>' +
    '</div>').join('');

  const cfg = r.suggestion
    ? '<div class="msg ok" style="margin-top:16px"><strong>Ready to add.</strong> Paste this into the ' +
      '<span class="mono">analyzers</span> array in config.json, set <span class="mono">id</span> and ' +
      '<span class="mono">equipmentCode</span>, and confirm the order-download dialect against the vendor spec ' +
      '&mdash; a capture of results cannot reveal it.</div>' +
      '<pre class="cfg">' + escHtml(JSON.stringify(r.suggestion, null, 2)) + '</pre>'
    : '<div class="msg warn" style="margin-top:16px">The best match is a protocol this connector does not implement yet. ' +
      'The evidence above is what a new codec in <span class="mono">src/codec/</span> would have to handle.</div>';

  $('identOut').innerHTML = '<p class="mut" style="margin:0 0 12px">' + r.bytes + ' bytes analysed</p>' + cands + observations(r) + cfg;
}

function observations(r) {
  if (!r.observations.length) return '';
  return '<div class="cand" style="margin-top:12px"><div class="cand-head"><span class="nm">Byte-level observations</span></div><ul>' +
    r.observations.map(o => '<li>' + escHtml(o) + '</li>').join('') + '</ul></div>';
}

async function analyzeCapture() {
  try { renderIdentify(await api('/api/connector/identify')); }
  catch (e) { note('bad', e.message); }
}

async function analyzePasted() {
  const data = $('pasteData').value;
  if (!data.trim()) return note('warn', 'Paste something to analyse.');
  try {
    renderIdentify(await api('/api/connector/identify', {
      method: 'POST', body: JSON.stringify({ data, mode: $('pasteMode').value }),
    }));
  } catch (e) { note('bad', e.message); }
}

let FAMILIES = {};
async function loadProtocols() {
  try {
    const r = await api('/api/connector/protocols');
    FAMILIES = r.families || {};
    // Group by family: a flat list of thirty protocols reads as a wall, and the
    // operator almost always knows what KIND of box is in front of them.
    const order = Object.keys(FAMILIES);
    const byFamily = {};
    for (const p of r.protocols) (byFamily[p.family] = byFamily[p.family] || []).push(p);
    $('protoList').innerHTML = order.filter(f => byFamily[f]).map(f =>
      '<div class="proto-fam"><h4>' + escHtml(FAMILIES[f]) + '</h4><div class="proto-list">' +
      byFamily[f].map(p =>
        '<span class="' + (p.supported ? 'sup' : '') + '" title="' + escHtml(p.id) +
        (p.supported ? ' — config protocol: ' + escHtml(p.supported) : '') + '">' + escHtml(p.name) + '</span>'
      ).join('') + '</div></div>').join('');
  } catch (e) { /* the list is informational */ }
}

onTypeChange();
loadProtocols();
poll();
setInterval(poll, 1500);
</script>
</body>
</html>`;
}
