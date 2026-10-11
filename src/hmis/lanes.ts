// =============================================================================
// HMIS lanes — which HMIS system(s) an analyzer files into.
//
// Two lanes exist: "hinai" (the Zydus HIMS /mirth/* gateway, HmisClient) and
// "genx" (GenX LIMS, GenxHmisClient). "mirth" is hinai's older name.
//
//   single mode — the analyzer uses exactly one lane (every analyzer until
//                 2026-10; behaviour is what it always was);
//   both mode   — the analyzer takes orders from, and files results into,
//                 BOTH systems. Added for IM, which the lab runs against HINAI
//                 and GenX side by side while GenX is brought in.
//
// The setting lives at the top of `hmis` and may be overridden per analyzer
// (`analyzers[].hmis` / `im.hmis`). Everything that needs to know an
// analyzer's lanes goes through lanesFor(), never through `hmis.api`.
// =============================================================================

export type Lane = 'hinai' | 'genx';

/** Canonical order: HINAI first. A row stored before lanes existed (no
 *  `source`) belongs to the analyzer's FIRST lane. */
export const LANES: readonly Lane[] = ['hinai', 'genx'];

export type HmisMode = 'single' | 'both';

export interface LaneSetting {
  mode?: HmisMode | null;
  use?: string | null;
}

/** How the console spells a lane. */
export function laneLabel(lane: Lane): string {
  return lane === 'genx' ? 'GenX' : 'HINAI';
}

function asLane(v: unknown): Lane | null {
  if (v === 'genx') return 'genx';
  if (v === 'hinai' || v === 'mirth') return 'hinai';
  return null;
}

/**
 * The lanes for one analyzer, from its own `hmis` override (if any) over the
 * top-level setting. Top level: `mode`/`use` win over the legacy `api`; with
 * no `mode`, api "genx" means single/genx and anything else single/hinai.
 * An override naming only `use` means single mode on that lane.
 */
export function resolveLanes(own: LaneSetting | null | undefined, top: (LaneSetting & { api?: string | null }) | null | undefined): Lane[] {
  const topMode: HmisMode = top?.mode === 'both' ? 'both' : 'single';
  const topUse: Lane = asLane(top?.use) ?? (top?.api === 'genx' ? 'genx' : 'hinai');
  const mode: HmisMode = own?.mode ?? (asLane(own?.use) ? 'single' : topMode);
  if (mode === 'both') return [...LANES];
  return [asLane(own?.use) ?? topUse];
}

/** An analyzer's lanes, HINAI first. Structural so it reads both the parsed
 *  config and a hand-built test fixture (which may carry no `hmis` at all). */
export function lanesFor(
  analyzer: { hmis?: LaneSetting | null },
  cfg: { hmis?: (LaneSetting & { api?: string | null }) | null },
): Lane[] {
  return resolveLanes(analyzer.hmis, cfg.hmis);
}

/** "HINAI", "GenX", or "HINAI + GenX (both)" — the console's HMIS line. */
export function describeLanes(lanes: readonly Lane[]): string {
  return lanes.length > 1 ? `${lanes.map(laneLabel).join(' + ')} (both)` : lanes.map(laneLabel).join('');
}
