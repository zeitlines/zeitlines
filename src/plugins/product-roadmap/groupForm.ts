// Drawer for a matrix group's title. A group has no row of its own: its title is
// the shared `group` value on all member features. Saving therefore patches those
// feature rows one by one through the generic store, preserving each row's own
// optimistic-lock counter.

import { Button, ConflictError, el, Field, FormActions, TextInput } from '../../pluginHost/viewApi';
import { apiListFeatures, apiMoveFeature, apiUpdateFeature } from './api';
import { currentPricing } from './compose';
import { file, hostApi, status } from './host';
import { PRICING_COLLECTIONS } from './manifest';
import { t } from './messages';
import { repaintPricingView } from './pricingMatrix';
import { renameGroupRows } from './groupRename';
import { moveGroupRows } from './groupOrder';
import { applyRow, orderRows } from './store';

export function showGroupForm(groupTitle: string): void {
  const title = groupTitle.trim();
  if (!title) return;

  const form = el('form', { class: 'ds-FormGrid group-form' }, [
    Field({
      label: t('group.title'),
      htmlFor: 'group-title',
      full: true,
      control: TextInput({ id: 'group-title', name: 'title', value: title, required: true }),
    }),
    FormActions({ children: [Button({ label: t('form.save'), type: 'submit' })] }),
  ]);

  hostApi().panel?.open({
    title,
    render: (container) => container.replaceChildren(form),
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveGroupTitle(title, form);
  });
  form.querySelector<HTMLInputElement>('#group-title')?.select();
}

async function saveGroupTitle(currentTitle: string, form: HTMLFormElement): Promise<void> {
  const nextTitle = String(new FormData(form).get('title') ?? '').trim();
  if (!nextTitle || nextTitle === currentTitle) return;

  try {
    await renameGroupRows(
      currentPricing(file()).features,
      currentTitle,
      nextTitle,
      apiUpdateFeature,
      apiListFeatures,
      (row) => applyRow(file(), PRICING_COLLECTIONS.features, row),
    );
    repaintPricingView();
    hostApi().panel?.close();
    status(t('group.updated', { name: nextTitle }));
  } catch (error) {
    // A group rename spans feature rows. Repaint even after a refusal so every
    // row already accepted by the host is visible in the snapshot immediately.
    repaintPricingView();
    if (error instanceof ConflictError) {
      status(t('refusal.group.conflict'));
      return;
    }
    status(t('refusal.saveFailed', { error: error instanceof Error ? error.message : String(error) }));
  }
}

/** Move every feature in a displayed group around its visible neighbour. */
export async function moveFeatureGroup(
  groupTitle: string,
  anchorTitle: string,
  side: 'before' | 'after',
): Promise<void> {
  try {
    await moveGroupRows(
      currentPricing(file()).features,
      groupTitle,
      anchorTitle,
      side,
      apiMoveFeature,
      (order) => orderRows(file(), PRICING_COLLECTIONS.features, order),
    );
    repaintPricingView();
  } catch (error) {
    // As with a rename, the operation spans rows. Show every order the host did
    // accept before reporting which later move it refused.
    repaintPricingView();
    status(t('refusal.group.moveFailed', { error: error instanceof Error ? error.message : String(error) }));
  }
}
