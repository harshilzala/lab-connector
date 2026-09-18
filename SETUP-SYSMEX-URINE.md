# Sysmex urinalysis pair (UC-3500 + UF-4000) — how it connects

Prepared 2026-09-16 from the manuals in
`C:\Users\APPADMIN\Downloads\fwsysmexusermanual` (UC-3500 Basic Operation,
General Information and Troubleshooting 1909; UF-4000 Basic Operation, General
Information and Troubleshooting 2302; two operator quick guides). Everything
below is either **from a manual** (section cited) or **assumed from the Sysmex
host-interface convention** and marked so. Nothing has been captured from this
site's wire yet — the last section is the checklist that turns the assumptions
into confirmed facts.

## What the two machines are

One urine sample, two instruments, one HMIS panel:

| | UC-3500 | UF-4000 |
|---|---|---|
| Measures | test **strip** chemistry: URO BLD PRO GLU KET BIL NIT LEU pH CRE ALB P/C A/C S.G COLOR CLOUD (GI §1.2) | urine **particles** by flow cytometry: RBC WBC EC CAST BACT X'TAL YLC SPERM MUCUS + sub-classes; body-fluid mode adds MN# MN% PMN# PMN% TNC (GI §1.3) |
| Host port | **RS-232C × 2, USB × 2 — serial only, no Ethernet** (GI §4 specifications) | **Ethernet** "used for the connection to the host computer" (GI §3.1 (5)) |
| Orders | host query per tube when [MEAS. SETTINGS] → [ORDER] = USE; [ORDER ERROR] = MEASURE / SKIP decides what happens when the host does not answer (BO §5.3.2) | [Query for analysis information] checkbox on the sampler / STAT dialogs, needs the host connected (BO §3.x) |
| Results | real-time output on by default ([RS-232C PARAMETER] → REAL-TIME OUTPUT, BO §5.4.2, §4.2.3); output filter by series (NO. / # / C.) × attribute (POS / NEG / ERROR) | [Auto Output(Host)] per NORMAL / REVIEW / ERROR / QC (BO §6.8.4); results must be **validated** before output — [Auto Validate] (BO §6.8.3) |
| Units on the wire | **always conventional**, whatever the display unit (BO §5.2); S.G. clamped to 1.000–1.050; "!" / "?" colour-interference marks on a value (BO §4.2.3) | **per-parameter setting**: /uL, /mL, /HPF, /LPF, rank "-,+,2+…", "**-**/uL" ranges (BO §6.8.5). HMIS's factor has to match what the site picks |
| QC | control ids registered by barcode, series [C.] (BO §2.6) | "UF CONTROL" material, QC results optionally output to host (BO §2.7.6) |
| Not a result | — | research parameters RBC-P70Fsc, RBC-Fsc-DW, Large/Small/Lysed RBC, SRC, Atyp.C, DEBRIS, Cond., Osmo. — "do not use for diagnosis" (GI §8.1.1); RBC-Info / UTI? judgement items (GI §5.6.4) |
| Barcode | ITF, NW-7, CODE39, JAN/EAN/UPC, CODE128; ≤ 22 digits, ≤ 14 with the CV-11 sampler; check digit recommended (GI §5.4) | same table (GI §5.5) |

The UC-3500 quick guide says **"Check QC results in UWAM"** — so the site has a
Sysmex **U-WAM** (Urinalysis Work Area Manager) PC between the analyzers and the
LIS. That is what makes "two machines, one result" work on Sysmex's side: the
U-WAM joins both instruments' values for a sample and can forward them as one
message.

## The two ways to cable it

### A — one link, through the U-WAM  (preferred if the U-WAM has a host connection licence)

```
UC-3500 ──RS-232C──┐
                   ├── U-WAM PC ──TCP/ASTM── LAB-CONNECTOR ── HMIS
UF-4000 ──Ethernet─┘
```

One analyzer block, one HMIS equipment code carrying **all** urine parameters:

```jsonc
{
  "id": "site-uwam",
  "profile": "sysmex-uwam",
  "equipmentCode": "XXURN01",          // the LabEquipment code HMIS gives the pair
  "transport": { "port": 6070 }        // the port typed into the U-WAM's host setting
}
```

### B — two links, straight to the analyzers

```
UC-3500 ──RS-232C (or NPort)── LAB-CONNECTOR ── HMIS
UF-4000 ──Ethernet ───────────┘
```

Two blocks, **two HMIS equipment codes**; HMIS maps the strip parameters to one
and the particle parameters to the other, and the same sample's panel completes
from both:

```jsonc
{
  "id": "site-uf4000",
  "profile": "sysmex-uf4000",
  "equipmentCode": "XXUF01",
  "transport": { "port": 6070 }        // the port set on the IPU's [Host Setting]
},
{
  "id": "site-uc3500",
  "profile": "sysmex-uc3500",
  "equipmentCode": "XXUC01",
  "transport": { "path": "COM3" }      // or, behind a Moxa NPort:
  // "transport": { "type": "tcp", "mode": "client", "host": "10.x.x.x", "port": 4001 }
}
```

Both profiles use **staged filing**: each machine's values file against the
rows that exist, the rest wait, one sample never blocks another. That is the
same mechanism the H360/BC-5150 sites run, and it is what lets two instruments
fill one panel in either order.

## What the profiles assume (and where each assumption comes from)

| Setting | Value | Status |
|---|---|---|
| Record layout | `sysmex` dialect: `^^^CODE` test ids (strip items prefixed `C-`), bare barcode in O field 3, every value twice as `<v>^RAW` / `<v>^MAINFORMAT`, `IF`-typed image records dropped, H `LIS2-A2`. Query is `Q\|1\|<barcode>\|\|\|\|<time>\|…\|F` — bare barcode, no rack/tube; the reply echoes it with report type `Q` | **Confirmed** — result upload from the U-WAM capture 2026-09-17 (`logs/wire-sysmex-uwam-2026-09-17.log`, pinned in `test/dialects-check.ts` [12]); Q record from the night of 2026-09-17/18 (five queries). Not yet observed: the U-WAM showing a downloaded order on its screen — every query so far hit a barcode HMIS listed no rows for at that moment (`test/query-reply-from-cache.test.ts`) |
| Value pairs | one per parameter: a blank half is never filed; a strip GRADE (`-`, `+-`, `1+` …) beats a concentration whichever half carries it; otherwise `astm.valueFormat` (profile `main` = /HPF, /LPF) | **Confirmed** over 193 messages, 2026-09-17/18: C-LEU grade in RAW with 25/75/500 c/µL in MAINFORMAT, C-BIL the mirror image, `+-` identical in both halves (C-BLD ×21, C-GLU ×15, C-PRO ×17); C-BLD occasionally numeric (`10`, `20` c/µL) in BOTH halves — filed as sent |
| Reported words | `testValueMap` on the `sysmex-uwam` profile: `-` → **Absent** (C-PRO, C-GLU, C-KET, C-BIL), **Negative** (C-NIT), **Normal** (C-URO, which arrives as the word `normal`); `+-` → **trace** (C-PRO, C-GLU); C-NIT `+` → **Positive**; `1+`…`4+` pass through; C-BLD, C-LEU, C-CLOUD, C-COLOR, C-PH, S.G. filed as sent | **Lab specification**, 2026-09-18 (pinned in `test/uwam-value-map.test.ts`). Applied at delivery time, so the spool is repaired by a corrected table. Strictly the U-WAM link |
| Line protocol | ASTM E1381 (ENQ/ACK, STX…ETX, checksum) | **Confirmed** — the U-WAM's frames were acknowledged and reassembled on 2026-09-17 |
| TCP side | U-WAM **dials** the PC (`mode: server`) on 2031 | **Confirmed** on 2026-09-17 (route A, `sysmex-uwam` block, eqCode EC014) |
| UC-3500 serial | 9600 8-N-1, DTR/RTS high | **Assumed** — read the real values off [RS-232C SETTINGS] (BO §5.4.2; service-set) |
| Host query | on, per tube | **From manual** (UC BO §5.3.2, UF BO §3) — must also be switched on at the instrument |
| Order push | off (`orderPoll.download: false`); rows still cached | Design — both instruments run their fixed panel regardless of the order, so a push adds nothing |
| Allow-list | none | Deliberate — scope is whatever HMIS registers under EC014 (8 of ~35 wire codes on 2026-09-17: WBC Clumps, SPERM, MUCUS, Lysed RBC, SRC, NL RBC, YLC, Tran.EC — spelled exactly as on the wire). Add the rest in the HMIS master, or `testCodeAliases` where HMIS names differ (`LEU`→`C-LEU`, `ERY`→`C-BLD`, `COL`→`C-COLOR`) |
| Ignore list | `*Info*` (RBC-Info. / UTI-Info. / BACT-Info.), `*?`, `C-Error Code`, `C-ColorRANK`, unregistered research parameters | **From capture + manual** (GI §8.1.1, §5.6.4). `Lysed RBC` and `SRC` are research items but HMIS registers them, so they are NOT ignored |
| QC ids | `QC`, `CTRL`, `UF CONTROL`, `UC CONTROL` … | **Partly assumed** — the UC's control ids are whatever the lab registered (BO §2.6); add the site's convention to `qc.sampleIdPrefixes` |

## What to ask Sysmex service for

1. The **host interface specification** for the UF-4000 (IPU) and the UC-3500,
   and the U-WAM's LIS specification if route A is taken. The user manuals
   explicitly defer to it (UC BO §5.3.2, §5.4.2 "contact your local Sysmex
   service representative").
2. On the UF-4000 IPU [Host Setting] and on the U-WAM: **protocol format**
   (ASTM), **IP address / port**, **client or server**, and whether patient
   demographics are expected back on a query reply.
3. On the UC-3500 [RS-232C SETTINGS]: **baud, data bits, parity, stop bits**,
   and which of the two serial ports is the host port (the other may be the
   U-WAM / sampler link).
4. The **test-order code(s)** the instruments expect in a query reply
   (`URI` / `BF` analysis mode, or a profile code) — these become the HMIS
   `eqIdntifier` values for the panel, nothing in this connector hard-codes them.

## HMIS side

- One `LabEquipment` row per link (one for route A, two for route B); its code
  is the block's `equipmentCode`.
- The urine routine service's parameter **identifiers** must be the
  instrument mnemonics exactly as they arrive on the wire (`GLU`, `PRO`, `RBC`,
  `WBC`, …). Where HMIS's row is named differently ("Pus cells" for WBC),
  add `testCodeAliases` in the block rather than renaming the HMIS master.
- Units: the UF's per-parameter unit is a site choice (/uL vs /HPF); set the
  HMIS parameter's unit to match, or put a factor in `testCodeScale`.

## Commissioning — turning assumptions into facts

1. **Cable and discover.** Dashboard → Connector Tool → *Discover* the lab
   VLAN for the IPU / U-WAM; for the UC-3500, enumerate COM ports and let the
   baud sweep rank the rate.
2. **Probe with no codec bound.** Listen on the port service typed into the
   host setting (or dial the IPU), *Auto-answer handshakes* on. Run one tube
   with the query on. The capture must show, in this order: `ENQ`, an H record
   naming `UF-4000` / `UC-3500` / `U-WAM`, a `Q` record with the barcode, `EOT`
   — then, after the run, H / P / O / R… / L with the values.
3. **Read the Q and R records against the table above.** Check: four carets
   before the code; sample number padding and `^rack^tube`; the mnemonics'
   spelling; units; whether the strip values are `NEGATIVE` / `1+` / `30` and
   what carries the `!` / `?` marks. Anything different goes into the `sysmex`
   dialect in `src/codec/astm/dialects.ts` and `test/dialects-check.ts` [12]–[17].
4. **Switch the block on** with `hostQuery: true` and watch the reply on the
   wire log. If the instrument rejects the reply (it runs but shows "no order",
   or [ORDER ERROR] fires on the UC), the first suspects are: report type `Q`
   vs `O` in O field 26, the echoed specimen field, the test code.
5. **Promote the allow-list.** Once a full run is captured, list the real
   codes in `allowTestCodes` on the profile so nothing outside the panel is
   ever offered to a patient record, and mark the dialect `confirmedBy` with
   the capture's date.
6. Run a control on each instrument and confirm it is logged as *QC — not sent
   to HMIS*; if the UC's control id is not caught, add its prefix.
