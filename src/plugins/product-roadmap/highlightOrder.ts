import type { PricingHighlight } from './types';

export type MoveHighlightRow = (
  highlightId: string,
  anchor: { after?: string; before?: string },
) => Promise<string[]>;

/** The visible neighbours of one highlight inside its own card section. */
export function highlightNeighbours(
  highlights: PricingHighlight[],
  highlightId: string,
): { previous?: PricingHighlight; next?: PricingHighlight } {
  const current = highlights.find((highlight) => highlight.id === highlightId);
  if (!current) return {};
  const section = current.section?.trim() ?? '';
  const peers = highlights.filter((highlight) => (highlight.section?.trim() ?? '') === section);
  const index = peers.findIndex((highlight) => highlight.id === highlightId);
  return {
    previous: index > 0 ? peers[index - 1] : undefined,
    next: index >= 0 && index < peers.length - 1 ? peers[index + 1] : undefined,
  };
}

/**
 * Move one highlight by one visible step without letting interleaved stored rows
 * change the first-seen order of the card sections.
 */
export async function moveHighlightRows(
  highlights: readonly PricingHighlight[],
  highlightId: string,
  anchorId: string,
  move: MoveHighlightRow,
  onOrder: (orderedIds: string[]) => void,
): Promise<number> {
  const current = highlights.find((highlight) => highlight.id === highlightId);
  const anchor = highlights.find((highlight) => highlight.id === anchorId);
  if (!current || !anchor || current.id === anchor.id) return 0;
  if ((current.section?.trim() ?? '') !== (anchor.section?.trim() ?? '')) return 0;

  const sectionOrder: string[] = [];
  const bySection = new Map<string, PricingHighlight[]>();
  for (const highlight of highlights) {
    const section = highlight.section?.trim() ?? '';
    if (!bySection.has(section)) {
      bySection.set(section, []);
      sectionOrder.push(section);
    }
    bySection.get(section)!.push(highlight);
  }
  const peers = bySection.get(current.section?.trim() ?? '')!;
  const from = peers.findIndex((highlight) => highlight.id === current.id);
  const to = peers.findIndex((highlight) => highlight.id === anchor.id);
  peers.splice(to, 0, peers.splice(from, 1)[0]);
  const desired = sectionOrder.flatMap((section) => bySection.get(section)!).map((highlight) => highlight.id);

  // Chaining every row after its desired predecessor normalises interleaved
  // storage as well as applying the visible one-step move. Every accepted host
  // order is mirrored before the next request, including on partial failure.
  for (let index = 1; index < desired.length; index += 1) {
    const order = await move(desired[index], { after: desired[index - 1] });
    onOrder(order);
  }
  return Math.max(0, desired.length - 1);
}
