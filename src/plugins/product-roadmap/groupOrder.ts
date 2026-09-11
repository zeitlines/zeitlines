// A displayed group is a block even though its features can be interleaved in
// the stored collection. Moving the title therefore has to move every member and
// leave their relative order intact. The host remains authoritative after each
// step: its returned full order is mirrored immediately, so a later failed move
// cannot leave the client showing an order the server never accepted.

import type { PricingFeature } from './types';

export type MoveFeatureRow = (
  featureId: string,
  anchor: { after?: string; before?: string },
) => Promise<string[]>;

/** Move one named feature group before or after another named feature group. */
export async function moveGroupRows(
  features: readonly PricingFeature[],
  groupTitle: string,
  anchorTitle: string,
  side: 'before' | 'after',
  move: MoveFeatureRow,
  onOrder: (orderedIds: string[]) => void,
): Promise<number> {
  const group = groupTitle.trim();
  const anchorGroup = anchorTitle.trim();
  if (!group || !anchorGroup || group === anchorGroup) return 0;

  const members = features.filter((feature) => feature.group?.trim() === group);
  const anchors = features.filter((feature) => feature.group?.trim() === anchorGroup);
  if (!members.length || !anchors.length) return 0;

  if (side === 'before') {
    let previousMember: string | undefined;
    for (const member of members) {
      const order = await move(
        member.id,
        previousMember ? { after: previousMember } : { before: anchors[0].id },
      );
      onOrder(order);
      previousMember = member.id;
    }
  } else {
    let after = anchors.at(-1)!.id;
    for (const member of members) {
      const order = await move(member.id, { after });
      onOrder(order);
      after = member.id;
    }
  }

  return members.length;
}
