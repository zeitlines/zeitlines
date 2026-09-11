// Renaming a matrix group means patching every feature that carries its title.
//
// Groups are deliberately derived from `PricingFeature.group`; there is no group
// row in the plugin store. Keeping the loop here gives the drawer one operation
// to call and, more importantly, keeps the optimistic-lock counter paired with
// the feature it belongs to. Each successful row is handed back immediately so
// a later conflict cannot leave the server ahead of the in-memory snapshot.

import { ConflictError, type PluginRow } from '../../pluginHost/api';
import type { PricingFeature } from './types';

export type UpdateFeatureGroup = (
  featureId: string,
  patch: Partial<PricingFeature>,
  rowVersion?: number,
) => Promise<PluginRow>;

export type ListFeatureRows = () => Promise<PluginRow[]>;

/** Patch the members of one displayed group, in their stored order. */
export async function renameGroupRows(
  features: readonly PricingFeature[],
  currentTitle: string,
  nextTitle: string,
  update: UpdateFeatureGroup,
  list: ListFeatureRows,
  onSaved: (row: PluginRow) => void,
): Promise<number> {
  const current = currentTitle.trim();
  const next = nextTitle.trim();
  if (!current || !next || current === next) return 0;

  const members = features.filter((feature) => feature.group?.trim() === current);
  for (const feature of members) {
    let saved: PluginRow;
    try {
      saved = await update(feature.id, { group: next }, feature.rowVersion);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      // A local JSON source locks the whole file. The preceding member changed
      // that file version, so this untouched row now carries a stale counter.
      // Read it again and continue only while its group still says what the user
      // is renaming. A concurrent group edit remains a real conflict.
      const fresh = (await list()).find((row) => row.id === feature.id);
      if (!fresh || String(fresh.data.group ?? '').trim() !== current) throw error;
      saved = await update(feature.id, { group: next }, fresh.version);
    }
    onSaved(saved);
  }
  return members.length;
}
