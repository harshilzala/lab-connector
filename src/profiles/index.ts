// =============================================================================
// MACHINE PROFILE LIBRARY
//
// One entry per analyzer MODEL. A profile carries everything that is a property
// of the instrument itself — which protocol it speaks, which side of the TCP
// connection it takes, its default port, its ACK conventions, the analytes it
// reports and the channels it emits that are not results. None of that changes
// when the same model is installed at another site.
//
// What a profile deliberately does NOT carry is anything that belongs to the
// SITE: the analyzer's IP address, the HMIS equipment code, the site's barcode
// prefixes, HMIS's own spelling of an analyte (testCodeAliases), and the
// polling / filing cadence the lab has asked for. Those stay in config.json.
//
// So a second BC-5150 anywhere in the group is:
//
//   {
//     "id": "site-bc5150",
//     "profile": "mindray-bc5150",
//     "equipmentCode": "XXXX001",
//     "transport": { "host": "10.x.x.x" }
//   }
//
// and nothing else, unless the site needs to override a default — every key
// written in the block wins over the profile, key by key (objects merge one
// level deep, arrays and scalars replace). Applied in src/config.ts before the
// schema validates, so a profile can never bypass validation.
//
// ADDING A MODEL: add an entry below. Record where each number came from — the
// vendor's protocol document, a wire capture, or a legacy config — the way the
// existing entries do. Do not put an analyte in `allowTestCodes` unless the
// instrument is documented to report it; the allow-list is what reaches a
// patient record.
// =============================================================================

/**
 * A profile is a partial analyzer block, in the same shape config.json uses.
 * Typed loosely on purpose: it is merged into the RAW config object and then
 * validated by the analyzer schema, which is the single source of truth for
 * what each field means and accepts.
 */
export interface AnalyzerProfile {
  /** One line on the instrument, shown in the config error when a profile name
   *  is mistyped, and in the admin console. */
  description: string;
  defaults: Record<string, unknown>;
}

// ---- Mindray BC-5000 / BC-5150 — 5-part haematology, HL7 v2.3.1 over MLLP --
//
// Source: "BC-5000&BC-5150 HL7 Communication Protocol V2.0 EN"
// (Mindray Z-110-002557-002-2.0) and the Shela installation, 2026-09-12:
//
//   • the ANALYZER is the TCP server — it listens on its own IP, port 5100
//     (Mindray default), and accepts exactly one LIS client at a time. The
//     connector dials it. Verified live: only 5100 open, a second client is
//     closed immediately, a bare 0x02 keep-alive arrives every 3 s (discarded
//     by the MLLP decoder as noise before the VT start block).
//   • results are ORU^R01, acknowledged with ACK^R01 echoing MSH-10 in MSA-2
//     and MSH-11 as received ("P" sample, "Q" QC) — §4.3.1, §5.2, §5.4.
//   • sample barcode in OBR-3, analyte mnemonic in OBX-3 component 2, ISO
//     units in OBX-6 (10*9/L, g/L …), flags N/A/H/L with "~" repeats — §4.3.6.
//   • only OBX-2 = NM carries a result; IS/ST/ED carry run modes, remarks,
//     alarm flags and Base64 histograms — §5.1.
//   • a QC message is marked by MSH-11 = Q; its OBR-3 is a QC FILE NUMBER,
//     not a barcode — §5.3. The link flags it from MSH-11, so no barcode rule
//     is needed to recognise a control here.
//   • worklist query, if ever enabled, is ORM^O01 → ORR^O02 (§4.2.3/4, §5.5),
//     which this connector's HL7 link does not yet speak: hostQuery stays off.
//   • a background count is sent as an ordinary ORU with OBR-3 = "Background"
//     (seven of the first twelve messages captured at Shela). It is an
//     instrument blank, not a sample: recognised by that id and kept out of
//     HMIS like a control.
//
// Confirmed on the first live capture (Shela, 2026-09-12, CBC+DIFF): WBC in
// 10*3/uL (not the 10*9/L the document shows — the unit follows the
// instrument setting; HMIS carries the factor), HGB g/dL, 5-part
// differential, and the research channels ignore-listed below — 70 OBX per
// message, five of them Base64 bitmaps totalling 184 KB.
//
// Reportable analytes (§5.8 "Parameter Result Items"), as the OBX-3 mnemonic.
// The 5-part differential is reported in CBC+DIFF mode, the 3-part
// (LYM/MID/GRAN) in CBC mode; both are listed so neither mode drops values.
// Research-use-only channels (*ALY, *LIC), Age and the histogram metadata are
// NM-typed but not results, and are left out.
const MINDRAY_BC5150: AnalyzerProfile = {
  description: 'Mindray BC-5000 / BC-5150 5-part haematology analyzer, HL7 v2.3.1 over MLLP; analyzer is the TCP server on port 5100',
  defaults: {
    protocol: 'hl7',
    transport: { type: 'tcp', mode: 'client', port: 5100 },
    sendDemographics: false,
    hostQuery: false,
    orderPoll: { enabled: true, download: false },
    filing: { mode: 'staged' },
    fillMissingOrderRows: true,
    qc: { sampleIdPrefixes: ['QC', 'QC-', 'CTRL', 'CONTROL', 'Background'] },
    allowTestCodes: [
      'WBC',
      'NEU#', 'NEU%',
      'LYM#', 'LYM%',
      'MON#', 'MON%',
      'EOS#', 'EOS%',
      'BAS#', 'BAS%',
      'MID#', 'MID%',
      'GRAN#', 'GRAN%',
      'RBC', 'HGB', 'HCT', 'MCV', 'MCH', 'MCHC', 'RDW-CV', 'RDW-SD',
      'PLT', 'MPV', 'PDW', 'PCT', 'PLCC', 'PLCR',
    ],
    // NM-typed lines the instrument interleaves with the CBC that are not
    // analytes: patient age (30525-0^Age^LN), histogram discriminator
    // positions and metadata lengths (15xxx^… Histogram. …^99MRC), and the
    // research-only immature-cell channels.
    ignoreTestCodes: [
      'Age', '*Histogram*', '*Scattergram*',
      // Research / flagging channels seen on the wire, none reportable.
      '*ALY#', '*ALY%', '*LIC#', '*LIC%',
      'Blast#', 'Blast%', 'Pltclump#', 'Pltclump%', 'Lip#', 'Lip%',
      'NLR', 'PLR', '*-X', '*-Y', '*-Z',
    ],
    testCodeScale: {},
    hl7: {
      sendingApp: 'LIS',
      sendingFacility: '',
      charset: 'UNICODE',
      ack: true,
      valueTypes: ['NM'],
      encoding: 'utf8',
      idleFlushMs: 0,
    },
  },
};

// ---- Mindray BC-6000 — 5-part haematology, HL7 v2.3.1 over MLLP -----------
//
// Source: the Cancer Centre installation (legacy Mindray_BC_6000\Lab
// Integration.exe.config: TCP listen :6060) and its wire log (8276 inbound
// ORU^R01, charset UNICODE, LOINC + 99MRC codes). Unlike the BC-5150, this
// model DIALS the LIS: the connector listens and the instrument connects.
//
// The 22 analytes are the set the Cancer lab scoped the interface to on
// 2026-09-07, checked against the HMIS equipment-parameter master on
// 2026-09-08 (test/bc6000-allow-codes.test.ts). The ignore list is the
// instrument's research channels and morphology suspect scores
// (test/bc6000-ignore-codes.test.ts).
const MINDRAY_BC6000: AnalyzerProfile = {
  description: 'Mindray BC-6000 5-part haematology analyzer, HL7 v2.3.1 over MLLP; analyzer dials the LIS',
  defaults: {
    protocol: 'hl7',
    transport: { type: 'tcp', mode: 'server', host: '0.0.0.0', port: 6060 },
    sendDemographics: false,
    hostQuery: false,
    orderPoll: { enabled: true, download: false },
    filing: { mode: 'staged' },
    fillMissingOrderRows: true,
    qc: { sampleIdPrefixes: ['QC', 'QC-', 'CTRL', 'CONTROL', '$'] },
    allowTestCodes: [
      'WBC',
      'NEU#', 'LYM#', 'MON#', 'EOS#', 'BAS#',
      'NEU%', 'LYM%', 'MON%', 'EOS%', 'BAS%',
      'RBC', 'HGB', 'HCT', 'MCV', 'MCH', 'MCHC', 'RDW-CV',
      'PLT', 'MPV', 'PDW', 'PCT',
    ],
    ignoreTestCodes: [
      '*-IM', 'InR*', 'PLT-I', 'WBC-D', 'TNC-D', 'WBC-N', 'TNC-N',
      'HFC#', 'HFC%', 'IME#', 'IME%', 'H-NR%', 'L-NR%', 'NLR', 'PLR',
    ],
    testCodeScale: {},
    hl7: {
      sendingApp: 'LIS',
      sendingFacility: '',
      charset: 'UNICODE',
      ack: true,
      valueTypes: ['NM'],
      encoding: 'utf8',
      idleFlushMs: 0,
    },
  },
};

// ---- Erba H360 — 3-part haematology, HL7 v2.3.1 over MLLP -----------------
//
// Source: the production wire log of the legacy middleware
// (E:\API_Integration\Devices\H360\H360.txt), pinned in test/hl7-h360.test.ts,
// and the Shela installation (ZHFC03), 2026-08-29 → 2026-09-16:
//
//   • the instrument DIALS the LIS — the connector listens; the site block
//     gives the PC address and the port the H360 is configured to dial
//     (3010 at Shela, from the legacy Lab Integration.exe.config).
//   • results are ORU^R01 (CBC+3DIFF), acknowledged with ACK^R01. Only
//     OBX-2 = NM carries a value; IS lines are run modes, ref group, remark
//     and the alarm flags (Leucopenia, Granulopenia …).
//   • the 22 numeric analytes below are exactly what the legacy middleware
//     filed (InsertData_Param.txt / arrOBX.log); Age and the histogram
//     metadata are NM-typed but not results.
//   • a blank run is sent as an ordinary ORU with OBR-3 = "background"
//     (H360.txt, 2026-09-06 21:16). Recognised by that id and kept out of
//     HMIS like a control. Operators have also keyed "BACKGROND" by hand.
//   • no barcode reader is in use at Shela: operators key "SF" + the last
//     four digits of the HMIS barcode ("sf0054" for SF2608290054), or just
//     the digits. The legacy middleware completed those before posting (its
//     Results log, 2026-08-29). That completion is a SITE setting, because
//     the barcode prefix is the site's — see below.
//   • the group HMIS CBC service (labServiceId 3141) is a PARAMETER service:
//     one labResultId covers the panel, so a row HMIS stops offering
//     mid-sample can be rebuilt from a sibling (fillMissingOrderRows), and
//     the same service carries peripheral-smear rows named "WBC" / "RBC" /
//     "PLATELET" (parameterIds 2166 / 2152 / 2162) that a count must never
//     file into — the BC-5150 fault of 2026-09-12. Both settings belong to
//     the HMIS the whole group shares, not to one site, so they sit here;
//     on a site where those ids are not registered they are a no-op.
//
// What a SITE block still has to say (see the Shela config.json):
//
//   {
//     "id": "erba-h360",
//     "profile": "erba-h360",
//     "equipmentCode": "ZHFC03",
//     "transport": { "host": "10.20.1.7", "port": 3010 },
//     // HMIS's report-line spellings of the analytes it registers under a
//     // name other than the instrument mnemonic — the group HMIS spells
//     // these three this way; a 3-part GRAN%/MID% is only an approximation
//     // of the 5-part Neutrophils/Monocytes rows and is a lab decision:
//     "testCodeAliases": { "HGB": "HAEMOGLOBIN", "HCT": "HEMATOCRIT", "LYM%": "Lymphocytes" },
//     // Short ids keyed on the instrument → the site's barcode. The prefix
//     // and shape are the site's (SF at Shela, ZC at the Cancer Centre …):
//     "barcodeCompletion": { "short": "(?:SF)?0*(\\d{1,4})", "full": "SF{yy}{mm}{dd}{seq:4}" }
//   }
const ERBA_H360: AnalyzerProfile = {
  description: 'Erba H360 3-part haematology analyzer, HL7 v2.3.1 over MLLP; analyzer dials the LIS',
  defaults: {
    protocol: 'hl7',
    transport: { type: 'tcp', mode: 'server', host: '0.0.0.0' },
    sendDemographics: false,
    hostQuery: false,
    orderPoll: { enabled: true, download: false },
    // Staged filing: results wait per sample for their order, one sample never
    // blocks another, and the console can re-key a mistyped id.
    filing: { mode: 'staged' },
    fillMissingOrderRows: true,
    excludeParameterIds: [2166, 2152, 2162],
    qc: { sampleIdPrefixes: ['QC', 'QC-', 'CTRL', 'CONTROL', 'Background', 'Backgrond'] },
    allowTestCodes: [
      'WBC', 'LYM%', 'GRAN%', 'MID%', 'LYM#', 'GRAN#', 'MID#',
      'RBC', 'HGB', 'HCT', 'MCV', 'MCH', 'MCHC', 'RDW-CV', 'RDW-SD',
      'PLT', 'MPV', 'PDW-SD', 'PDW-CV', 'PCT', 'P-LCR', 'P-LCC',
    ],
    ignoreTestCodes: ['Age', '*Histogram*'],
    testCodeScale: {},
    hl7: {
      sendingApp: 'LIS',
      sendingFacility: '',
      charset: 'UNICODE',
      ack: true,
      valueTypes: ['NM'],
      encoding: 'utf8',
      idleFlushMs: 0,
    },
  },
};

// ---- Lifotronic GH900 Plus — HbA1c (HPLC), proprietary block over TCP -----
//
// Source: GH900 Plus operator's manual, Appendix B "Communication":
//   • the PC is the TCP SERVER (B.1 "TCP Communication Mode on PC: TCP
//     Server", default port 8000) and the analyzer dials in — so the
//     connector listens; the site block gives the PC address and port.
//   • one fixed-width STX 'S' … ETX block per test (B.3), no acknowledgement,
//     no query. Results-only.
//   • blood-type byte 0x32 = QC material, 0x33 = calibrator (B.2): the link
//     marks those runs QC itself, no barcode rule needed.
//   • error code 0x31/0x32 = E1/E2 sampling error: such a run is dropped, not
//     filed (gh900.fileOnSamplingError).
//
// The instrument sends VALUES BY POSITION, not codes. The codes below are the
// connector's own names for those positions (src/codec/gh900/parser.ts,
// GH900_CODES); HMIS's spelling is mapped per site with testCodeAliases. The
// allow-list is the clinically reported set; the individual fraction ratios
// (HbA1a, HbA1b, LA1c, HbA0) are parsed but not filed unless a site adds them.
const LIFOTRONIC_GH900PLUS: AnalyzerProfile = {
  description: 'Lifotronic GH900 Plus HbA1c analyzer, proprietary fixed-width block over TCP; analyzer dials the LIS (PC is server, default port 8000)',
  defaults: {
    protocol: 'gh900',
    transport: { type: 'tcp', mode: 'server', host: '0.0.0.0', port: 8000 },
    sendDemographics: false,
    hostQuery: false,
    orderPoll: { enabled: true, download: false },
    filing: { mode: 'staged' },
    qc: { sampleIdPrefixes: ['QC', 'QC-', 'CTRL', 'CONTROL', 'CAL'] },
    allowTestCodes: ['HBA1C', 'HBA1C-IFCC', 'EAG-MGDL', 'EAG-MMOL', 'HBF'],
    ignoreTestCodes: [],
    testCodeScale: {},
    gh900: { fileOnSamplingError: false },
  },
};

// ---- Ortho / QuidelOrtho VITROS ECi / ECiQ — immunodiagnostic, ASTM E1381/E1394
//
// Source: the Cancer Centre installation (legacy E:\Devices_Cancer\ECiQ\
// Vitros_ECiQ.exe.config: ComVal=COM1 9600 8-N-1, ProactiveUpload=true,
// SampleIdPrefix=ZC) and its production wire log
// (logs/wire-cancer-vitros-eciq.log, 2026-09-07). The record layout is the
// `vitros-eciq` dialect in src/codec/astm/dialects.ts, confirmed byte-for-byte
// against the legacy host's outgoing traffic.
//
//   • the instrument is a SERIAL device (RS-232, 9600 8-N-1). Every site so
//     far reaches it through a Moxa NPort in TCP Server mode, which LISTENS
//     and the connector dials — hence transport mode "client". The NPort's
//     address AND port are site wiring (4001 = NPort serial port 1, 4002 =
//     port 2), so the block must give both. A site cabled straight to a COM
//     port writes a serial transport instead; the schema drops the profile's
//     tcp-only keys.
//   • it does not host-query; orders are pushed proactively as the legacy app
//     did (ProactiveUpload=true), so orderPoll download is on.
//   • the analyzer's own H record carries sender "HOST" and NO receiver id,
//     processing id or version — senderId/receiverId mirror that.
//   • ASTM.log: "ASTM ORDER SEND START | sendEnqFirst=True" then a 15 s ACK
//     timeout — ackTimeoutMs.
//   • demographics ARE sent: the legacy host put the patient name on the P
//     record (P|1|<id>|||<NAME>^^|||<sex>).
//   • controls run under a bare-numeric id (40471, 40472 beside patient
//     ZC2609060012 in the wire log). Only a site's qc.patientPrefixes allow-
//     list catches those, and the prefix is the site's — it stays in the
//     block.
//
// No allow-list: VITROS assay codes reach HMIS as the dilution-qualified
// identifier ("1.000000+032+1") that the dialect canonicalises on both sides,
// and every one of them is a reportable result.
const VITROS_ECIQ: AnalyzerProfile = {
  description: 'Ortho/QuidelOrtho VITROS ECi / ECiQ immunodiagnostic, ASTM E1381/E1394 over serial; reached through a Moxa NPort the connector dials',
  defaults: {
    protocol: 'astm',
    transport: { type: 'tcp', mode: 'client' },
    sendDemographics: true,
    hostQuery: false,
    orderPoll: { enabled: true, download: true },
    qc: { sampleIdPrefixes: ['QC', 'QC-', 'CTRL', 'CONTROL', '$'], upload: false },
    astm: {
      ackTimeoutMs: 15000,
      frameMaxData: 240,
      senderId: 'HOST',
      receiverId: '',
      dialect: 'vitros-eciq',
      sampleIdFrom: 'order',
    },
  },
};

// ---- Ortho / QuidelOrtho VITROS 250 — chemistry, KERMIT file transfer -------
//
// Source: the Cancer Centre installation (legacy E:\Devices_Cancer\Vitros250\
// Vitros250.exe.config: ComVal=COM2 9600 8-N-1, VitrosDelayTime=1000,
// SamplePrefix=ZC, barcodeLength=9), Vitros250_String.txt (SOH / seq / type-Y
// ACK framing) and this connector's own run on 2026-09-07.
//
//   • NOT ASTM. Sample programs go down as named files (SFILEn.D) and results
//     come back as files (R00000nn) over Kermit — see src/codec/kermit.
//   • serial device behind a Moxa NPort in TCP Server mode, dialled by the
//     connector; NPort host and port are site wiring (see the ECiQ note).
//   • no host query: orders are pushed proactively.
//   • packet pacing is load-bearing. Vitros250.exe paced every packet by 1 s
//     and never drew an error in 48 captured transfers; without the pause the
//     analyzer answered "0005 INVALID PACKET USAGE" x125 and "0008 INVALID
//     SEQUENCE USE" x35 in one day, 151 of them within two seconds of the
//     previous transfer. Both delays stay at 1000 ms.
//   • controls run under a bare-numeric id (Result_Flow.log: "Skipped result
//     sample=89772 (prefix filter: ZC)"). The site's barcode prefix goes in
//     the block as qc.patientPrefixes and orderPoll.downloadPrefixes — the
//     Cancer site measured 95% of HMIS's rows under this eqCode were for tubes
//     the instrument never sees.
const VITROS_250: AnalyzerProfile = {
  description: 'Ortho/QuidelOrtho VITROS 250 chemistry, KERMIT file transfer over serial; reached through a Moxa NPort the connector dials',
  defaults: {
    protocol: 'kermit',
    transport: { type: 'tcp', mode: 'client' },
    sendDemographics: true,
    hostQuery: false,
    orderPoll: { enabled: true, download: true },
    qc: { sampleIdPrefixes: ['QC', 'QC-', 'CTRL', 'CONTROL', '$'], upload: false },
    kermit: {
      ackTimeoutMs: 10000,
      maxRetries: 5,
      interPacketDelayMs: 1000,
      interTransferDelayMs: 1000,
    },
  },
};

// ---- Snibe Maglumi — chemiluminescence immunoassay, ASTM E1381/E1394 --------
//
// Source: Snibe "Chapter 16: Host Result Management" §16.4.2–16.4.3, the
// three captured Maglumi wire logs replayed by test/dialects-check.ts, and the
// first production block of this connector (config.json at commit 42dcfe0,
// id "meglumi", eqCode MGAPI1000). The record layout is the `maglumi` dialect
// in src/codec/astm/dialects.ts.
//
//   • the ANALYZER dials the LIS: its LIS screen is given the host's IP and
//     port, so the connector listens ("server"). The listening port is
//     whatever the site typed into that screen (2807 at the first site) —
//     it stays in the block.
//   • it HOST-QUERIES: a Q record per tube (Q|1|^1234567||ALL||||||||O) and
//     expects the order back, one O record per assay, H stamped with an
//     8-digit date. hostQuery on; the proactive push is left off because the
//     instrument asks for what it needs.
//   • the analyzer's H record names itself "Maglumi 1000" / "Maglumi User"
//     and addresses "Lis"; the download answers with receiverId "Lis" as the
//     spec example does.
//   • demographics off — the spec's own download example sends a bare P|1.
//   • a control record can carry the LOT NAME as its sample id
//     ("KN TG 2 <0.02", test/spool-badname.test.ts); "$"-prefixed and QC/CTRL
//     ids are the documented forms.
//
// No allow-list: assay codes are the plain mnemonic (TSH, FT4, CA125 …) and
// each Maglumi is scoped by whichever assays HMIS registers under its eqCode.
const SNIBE_MAGLUMI: AnalyzerProfile = {
  description: 'Snibe Maglumi chemiluminescence immunoassay analyzer, ASTM E1381/E1394 over TCP; analyzer dials the LIS and host-queries each tube',
  defaults: {
    protocol: 'astm',
    transport: { type: 'tcp', mode: 'server', host: '0.0.0.0' },
    sendDemographics: false,
    hostQuery: true,
    orderPoll: { enabled: false },
    qc: { sampleIdPrefixes: ['QC', 'QC-', 'CTRL', 'CONTROL', '$'], upload: false },
    astm: {
      ackTimeoutMs: 15000,
      frameMaxData: 240,
      senderId: 'HMIS-LIS',
      receiverId: 'Lis',
      dialect: 'maglumi',
      sampleIdFrom: 'order',
    },
  },
};

// ---- Sysmex UF-4000 / UF-5000 + UC-3500 (+ U-WAM) — urinalysis, ASTM E1381/E1394
//
// Source: the site's Sysmex manuals (C:\Users\APPADMIN\Downloads\
// fwsysmexusermanual, read 2026-09-16) — UC-3500 Basic Operation (BO) and
// General Information (GI) 1909, UF-4000 BO / GI / TS 2302, and the two
// operator quick guides — plus the Sysmex host-interface convention the
// XN/UF/UC family shares. None of the manuals carries the record layout
// ("for interface specifications ... contact your local Sysmex service
// representative", UC-3500 BO §5.3.2, §5.4.2). The layout is the `sysmex`
// dialect in src/codec/astm/dialects.ts, CONFIRMED for the result upload
// by the Ahmedabad U-WAM capture of 2026-09-17 (route A: the U-WAM dials
// the PC on 2031, eqCode EC014). SETUP-SYSMEX-URINE.md keeps the
// assumed-vs-confirmed table.
//
// What the capture established (logs/wire-sysmex-uwam-2026-09-17.log):
//
//   • the U-WAM sends ONE message per sample with both instruments' values,
//     R field 14 naming UC-3500 or UF-4000. Strip items carry a "C-" prefix
//     (C-GLU, C-PRO, C-PH, C-S.G.(Ref), C-COLOR, C-CLOUD, C-Error Code …);
//     particles are bare (RBC, WBC, EC, Squa.EC, Non SEC, Tran.EC, RTEC,
//     CAST, Hy.CAST, Path.CAST, BACT, X'TAL, YLC, SPERM, MUCUS, NL RBC,
//     WBC Clumps) plus RBC-Info. / UTI-Info. / BACT-Info. judgements and
//     seven scattergram image records.
//   • every value comes twice, RAW and MAINFORMAT (astm.valueFormat picks;
//     the profile files MAINFORMAT — what the U-WAM shows the lab).
//   • HMIS (EC014, "Urine examination", labServiceId 414) registers its
//     identifiers in exactly the wire spelling: WBC Clumps, SPERM, MUCUS,
//     Lysed RBC, SRC, NL RBC, YLC, Tran.EC. Lysed RBC and SRC are research
//     parameters by the manual, but the lab has registered them, so they
//     are NOT ignore-listed here.
//
// What the manuals DO establish:
//
//   • Two instruments share one urine sample: the UC-3500 reads the test
//     strip (URO BLD PRO GLU KET BIL NIT LEU pH CRE ALB P/C A/C S.G COLOR
//     CLOUD — GI §1.2), the UF-4000 counts the particles by flow cytometry
//     (RBC WBC EC CAST BACT X'TAL YLC SPERM MUCUS and the sub-classes;
//     body-fluid mode adds MN#/MN% PMN#/PMN% TNC — GI §1.3). HMIS holds
//     one urine routine panel, so each link files its half and the panel
//     completes when both have reported: staged filing, never queue.
//   • UC-3500 is SERIAL ONLY: "External input/output: RS-232C output x 2,
//     USB x 2" (GI §4 specifications); no Ethernet port on the analyzer.
//     It host-queries when [MEAS. SETTINGS] → [ORDER] = USE (BO §5.3.2),
//     outputs results in real time by default (BO §4.2.3, "REAL-TIME
//     OUTPUT" in [RS-232C PARAMETER], §5.4.2) and always in CONVENTIONAL
//     units on the wire whatever the display unit (BO §5.2). S.G. is
//     clamped to 1.000–1.050. Colour-interference marks "!" / "?" ride on
//     the value.
//   • UF-4000 is ETHERNET: "(5) Ethernet ports — used for the connection to
//     the host computer" (GI §3.1). [System Settings] → [Host] enables the
//     link (BO §6.4.6); [Query for analysis information] on the sampler /
//     STAT dialogs asks the host per tube (BO §3); [Auto Output(Host)]
//     picks NORMAL / REVIEW / ERROR / QC results to push (BO §6.8.4). The
//     unit per parameter is a setting (/uL, /HPF, /LPF, rank "-,+,2+" …,
//     BO §6.8.5): HMIS's factor must match whatever the site chooses.
//     Research parameters (RBC-P70Fsc, RBC-Fsc-DW, Large/Small/Lysed RBC,
//     SRC, Atyp.C, DEBRIS, Cond., Osmo. — GI §8.1.1) are "not for
//     diagnosis" and are ignore-listed; so are the Info/flag items
//     (RBC-Info, UTI?, …, GI §5.6.4).
//   • The operator quick guide says "Check QC results in UWAM": the site
//     has a Sysmex U-WAM (Urinalysis Work Area Manager) PC between the two
//     analyzers and the LIS. Where the LIS connects to the U-WAM instead of
//     the analyzers, ONE TCP link carries both instruments' values for a
//     sample — that is the `sysmex-uwam` profile.
//   • Which side of the TCP connection the IPU / U-WAM takes is a Sysmex
//     service setting (host IP + port + client/server on their screen).
//     The profile assumes the analyzer dials the PC — the common Sysmex
//     setup — and the site block gives the port; flip `transport.mode`
//     to "client" with the analyzer's IP if service configured it the other
//     way round.
//   • Serial parameters for the UC-3500 ([RS-232C SETTINGS], BO §5.4.2)
//     are set by service; 9600 8-N-1 is the family default and an
//     assumption until read off that screen.
//
// No allow-list on any of the three: the scope is set by which parameters
// HMIS registers under the equipment code, and the site is still mapping
// them (8 of the ~35 wire codes were registered on 2026-09-17). An
// allow-list here would have to be edited each time HMIS adds one.
const SYSMEX_ASTM = {
  ackTimeoutMs: 15000,
  frameMaxData: 240,
  senderId: 'HMIS-LIS',
  receiverId: '',
  dialect: 'sysmex',
  sampleIdFrom: 'order',
  valueFormat: 'main',
} as const;

/** Sysmex QC material ids as they can appear as a sample number. The UF
 *  runs "UF CONTROL"; the UC-3500 registers control ids by barcode (BO
 *  §2.6) — the operator's convention for those goes in the site block. */
const SYSMEX_QC_PREFIXES = ['QC', 'QC-', 'CTRL', 'CONTROL', 'UF CONTROL', 'UF-CONTROL', 'UFCONTROL', 'UF CTRL', 'UC CONTROL', 'UC-CONTROL'];

/** Lines that are not reportable results: the RBC-Info. / UTI-Info. /
 *  BACT-Info. judgement items (GI §5.6.4, "0" on the wire), any
 *  "?"-suffixed suspect flag, the UC-3500's error code and colour-rank
 *  bookkeeping, and the research parameters the manual marks "not for
 *  diagnosis" (GI §8.1.1) that HMIS has NOT registered. Lysed RBC and SRC
 *  are research parameters too, but HMIS registers both under EC014, so
 *  they file. The scattergram image records never reach this list — the
 *  dialect drops them. */
const UF_IGNORE_CODES = [
  '*Info*', '*?', 'C-Error Code', 'C-ColorRANK',
  'RBC-P70Fsc', 'RBC-Fsc-DW', 'Large RBC', 'Small RBC', 'Atyp.C', 'DEBRIS', 'Cond.', 'Osmo.',
];

const SYSMEX_UF4000: AnalyzerProfile = {
  description: 'Sysmex UF-4000 / UF-5000 urine particle analyzer, ASTM E1381/E1394 over TCP; analyzer dials the LIS and host-queries each tube',
  defaults: {
    protocol: 'astm',
    transport: { type: 'tcp', mode: 'server', host: '0.0.0.0' },
    sendDemographics: false,
    hostQuery: true,
    // Rows are cached by the poll so a value files even when the tube was
    // run with [Query for analysis information] off; nothing is pushed —
    // the instrument runs its fixed panel regardless of the order.
    orderPoll: { enabled: true, download: false },
    // Half a panel per instrument: each value files when its row exists and
    // the rest wait, one sample never blocking another.
    filing: { mode: 'staged' },
    fillMissingOrderRows: true,
    qc: { sampleIdPrefixes: SYSMEX_QC_PREFIXES, upload: false },
    ignoreTestCodes: UF_IGNORE_CODES,
    testCodeScale: {},
    astm: SYSMEX_ASTM,
  },
};

const SYSMEX_UC3500: AnalyzerProfile = {
  description: 'Sysmex UC-3500 urine chemistry (test strip) analyzer, ASTM E1381/E1394 over RS-232C; host-queries each tube. Site block gives the COM port (or an NPort to dial)',
  defaults: {
    protocol: 'astm',
    // RS-232C is the ONLY host port on this analyzer (GI §4). 9600 8-N-1 is
    // the assumed setting — read the real one off [RS-232C SETTINGS].
    transport: { type: 'serial', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', dtr: true, rts: true },
    sendDemographics: false,
    hostQuery: true,
    orderPoll: { enabled: true, download: false },
    filing: { mode: 'staged' },
    fillMissingOrderRows: true,
    qc: { sampleIdPrefixes: SYSMEX_QC_PREFIXES, upload: false },
    ignoreTestCodes: ['C-Error Code', 'C-ColorRANK'],
    testCodeScale: {},
    astm: SYSMEX_ASTM,
  },
};

/** The words the group HMIS reports the U-WAM's strip pads as — the lab's
 *  table of 2026-09-18, one row per pad: "-" is Absent (protein, glucose,
 *  ketone, bilirubin), Negative (nitrite) or Normal (urobilinogen); "+-" is
 *  trace; "+" on nitrite is Positive; the grades "1+" … "4+" pass through.
 *  Urobilinogen arrives as the word "normal" (lower case) rather than "-"
 *  on this U-WAM (137 of 137 negatives on 2026-09-17/18), so both spellings
 *  are listed. Pads the table does not name (C-BLD, C-LEU, C-CLOUD,
 *  C-COLOR, C-PH, C-S.G.(Ref)) are filed as the instrument sends them.
 *  Strictly the U-WAM link: a UF-4000 or UC-3500 connected on its own has
 *  no such table yet. */
const UWAM_VALUE_MAP: Record<string, Record<string, string>> = {
  'C-PRO': { '-': 'Absent', '+-': 'trace' },
  'C-GLU': { '-': 'Absent', '+-': 'trace' },
  'C-KET': { '-': 'Absent' },
  'C-URO': { '-': 'Normal', normal: 'Normal' },
  'C-BIL': { '-': 'Absent' },
  'C-NIT': { '-': 'Negative', '+': 'Positive' },
};

const SYSMEX_UWAM: AnalyzerProfile = {
  description: "Sysmex U-WAM urinalysis work-area manager fronting a UC-3500 + UF-4000/UF-5000 pair, ASTM E1381/E1394 over TCP; one link carries both instruments' results per sample",
  defaults: {
    protocol: 'astm',
    transport: { type: 'tcp', mode: 'server', host: '0.0.0.0' },
    sendDemographics: false,
    hostQuery: true,
    orderPoll: { enabled: true, download: false },
    filing: { mode: 'staged' },
    fillMissingOrderRows: true,
    qc: { sampleIdPrefixes: SYSMEX_QC_PREFIXES, upload: false },
    ignoreTestCodes: UF_IGNORE_CODES,
    testCodeScale: {},
    testValueMap: UWAM_VALUE_MAP,
    astm: SYSMEX_ASTM,
  },
};

export const PROFILE_LIBRARY = {
  'mindray-bc5150': MINDRAY_BC5150,
  /** Same protocol document and defaults as the BC-5150. */
  'mindray-bc5000': MINDRAY_BC5150,
  'mindray-bc6000': MINDRAY_BC6000,
  'erba-h360': ERBA_H360,
  'lifotronic-gh900plus': LIFOTRONIC_GH900PLUS,
  'vitros-eciq': VITROS_ECIQ,
  /** Same host interface and dialect as the ECiQ. */
  'vitros-eci': VITROS_ECIQ,
  'vitros-250': VITROS_250,
  'snibe-maglumi': SNIBE_MAGLUMI,
  'sysmex-uf4000': SYSMEX_UF4000,
  /** Same IPU host interface as the UF-4000. */
  'sysmex-uf5000': SYSMEX_UF4000,
  'sysmex-uc3500': SYSMEX_UC3500,
  'sysmex-uwam': SYSMEX_UWAM,
} as const satisfies Record<string, AnalyzerProfile>;

export type ProfileName = keyof typeof PROFILE_LIBRARY;
export const PROFILE_NAMES = Object.keys(PROFILE_LIBRARY) as [ProfileName, ...ProfileName[]];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Lay a raw analyzer block over its profile's defaults.
 *
 * Merge rule, chosen so a site can always say exactly what it means:
 *   • a key present in the block wins;
 *   • objects merge one level deep (transport.host from the block, transport
 *     port/mode/type from the profile);
 *   • arrays and scalars replace — an allow-list written in the block IS the
 *     allow-list, never the union. A site that wants the profile's list plus
 *     one code copies the list; that keeps "what reaches a patient record"
 *     readable in one place.
 * A block without `profile` is returned untouched, so every existing config
 * keeps working as written.
 */
export function applyProfile(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const name = raw.profile;
  if (name === undefined) return raw;
  if (typeof name !== 'string' || !(name in PROFILE_LIBRARY)) {
    // Leave the bad value in place: the schema enum rejects it with the list
    // of valid names, which is a better error than throwing here.
    return raw;
  }
  const profile = PROFILE_LIBRARY[name as ProfileName].defaults;
  const out: Record<string, unknown> = { ...profile };
  for (const [key, value] of Object.entries(raw)) {
    const base = profile[key];
    out[key] = isPlainObject(base) && isPlainObject(value) ? { ...base, ...value } : value;
  }
  return out;
}

/** Apply profiles to every analyzer in a raw (pre-validation) config object. */
export function applyProfiles(rawConfig: unknown): unknown {
  if (!isPlainObject(rawConfig) || !Array.isArray(rawConfig.analyzers)) return rawConfig;
  return { ...rawConfig, analyzers: rawConfig.analyzers.map(applyProfile) };
}
