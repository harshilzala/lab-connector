// =============================================================================
// HMIS lanes — which HMIS system(s) an analyzer files into.
//
// Three lanes exist, each a separate API:
//   "hinai" — the Zydus HIMS /mirth/* gateway (HmisClient). "mirth" is its
//             older name.
//   "genx"  — GenX LIMS Lab Equipment API (GenxHmisClient).
//   "tatva" — Tatva v1, the ZyHos partner Lab Middleware API (src/hmis/tatva.ts).
//
//   single mode — the analyzer uses exactly one lane: `use`.
//   both mode   — the analyzer takes orders from, and files results into, TWO
//                 lanes side by side: the pair named in `both`, any two of the
//                 three (["hinai", "genx"], ["hinai", "tatva"], ["genx", "tatva"]).
//                 With no `both` the pair is ["hinai", "genx"], as it was before
//                 Tatva became a lane, so an older config reads unchanged.
//
// The setting lives at the top of `hmis` and may be overridden per analyzer
// (`analyzers[].hmis` / `im.hmis`). Every analyzer — whatever its protocol —
// goes through lanesFor(), never through `hmis.api`, so a machine added later
// files in single or both mode with no extra wiring.
// =============================================================================

export type Lane = 'hinai' | 'genx' | 'tatva';

/** Canonical order: HINAI first. A row stored before lanes existed (no
 *  `source`) belongs to the analyzer's FIRST lane. */
export const LANES: readonly Lane[] = ['hinai', 'genx', 'tatva'];

/** The pair both mode uses when the config names none. */
export const DEFAULT_BOTH: readonly Lane[] = ['hinai', 'genx'];

export type HmisMode = 'single' | 'both';

export interface LaneSetting {
  mode?: HmisMode | null;
  use?: string | null;
  /** Both mode: the two lanes to use. */
  both?: readonly string[] | null;
}

/** How the console spells a lane. */
export function laneLabel(lane: Lane): string {
  if (lane === 'genx') return 'GenX';
  if (lane === 'tatva') return 'Tatva';
  return 'HINAI';
}

export function asLane(v: unknown): Lane | null {
  if (v === 'genx') return 'genx';
  if (v === 'tatva') return 'tatva';
  if (v === 'hinai' || v === 'mirth') return 'hinai';
  return null;
}

/** A `both` list as lanes in canonical order, duplicates and unknown names
 *  dropped; null when nothing usable was given. */
export function bothLanes(v: readonly string[] | null | undefined): Lane[] | null {
  if (!v || !v.length) return null;
  const set = new Set(v.map(asLane).filter((l): l is Lane => l !== null));
  const out = LANES.filter((l) => set.has(l));
  return out.length ? out : null;
}

/**
 * The lanes for one analyzer, from its own `hmis` override (if any) over the
 * top-level setting. Top level: `mode`/`use` win over the legacy `api`; with
 * no `mode`, api "genx" means single/genx and anything else single/hinai.
 * An override naming only `use` means single mode on that lane; one naming
 * only `both` means both mode on that pair.
 */
export function resolveLanes(own: LaneSetting | null | undefined, top: (LaneSetting & { api?: string | null }) | null | undefined): Lane[] {
  const topMode: HmisMode = top?.mode === 'both' ? 'both' : 'single';
  const topUse: Lane = asLane(top?.use) ?? asLane(top?.api) ?? 'hinai';
  const mode: HmisMode = own?.mode ?? (asLane(own?.use) ? 'single' : bothLanes(own?.both) ? 'both' : topMode);
  if (mode === 'both') return bothLanes(own?.both) ?? bothLanes(top?.both) ?? [...DEFAULT_BOTH];
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

/** "HINAI", "Tatva", or "HINAI + GenX (both)" — the console's HMIS line. */
export function describeLanes(lanes: readonly Lane[]): string {
  return lanes.length > 1 ? `${lanes.map(laneLabel).join(' + ')} (both)` : lanes.map(laneLabel).join('');
}
