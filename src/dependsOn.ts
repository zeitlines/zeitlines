import type { TimelineFileItem } from './types';

/** Which item ids this item points at through `metadata.dependsOn`. */
export function dependsOnOf(item: TimelineFileItem): string[] {
  const value = item.metadata?.dependsOn;
  if (Array.isArray(value)) return value.map(String).filter((entry) => entry.length > 0);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}
