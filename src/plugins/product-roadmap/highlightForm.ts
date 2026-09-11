import {
  Button,
  Chip,
  ChipBox,
  ChipBoxSlot,
  ConflictError,
  el,
  Field,
  FieldError,
  FormActions,
  highlightSuggestion,
  SuggestEmpty,
  SuggestItem,
  SuggestList,
  TextArea,
  TextInput,
} from '../../pluginHost/viewApi';
import { apiAddHighlight, apiDeleteHighlight, apiMoveHighlight, apiUpdateHighlight } from './api';
import { currentPricing } from './compose';
import { file, hostApi, status } from './host';
import { PRICING_COLLECTIONS } from './manifest';
import { t } from './messages';
import { slugId } from './pricing';
import { repaintPricingView } from './pricingMatrix';
import { moveHighlightRows } from './highlightOrder';
import { applyRow, dropRow, orderRows } from './store';
import type { PricingHighlight } from './types';

function findHighlight(id: string): PricingHighlight | undefined {
  return currentPricing(file()).highlights?.find((highlight) => highlight.id === id);
}

function sections(): string[] {
  const values = new Set<string>();
  for (const highlight of currentPricing(file()).highlights ?? []) {
    const section = highlight.section?.trim();
    if (section) values.add(section);
  }
  return [...values].sort((a, b) => a.localeCompare(b, 'de'));
}

export function showHighlightForm(highlightId?: string): void {
  const pricing = currentPricing(file());
  const highlight = highlightId ? findHighlight(highlightId) : undefined;
  if (highlightId && !highlight) return;
  const selected = new Set(highlight?.featureIds ?? []);
  const featureChips = ChipBoxSlot({ attrs: { 'data-role': 'highlight-feature-chips' } });
  const featureSearch = TextInput({
    id: 'hl-feature-search',
    bare: true,
    placeholder: t('highlight.search'),
    attrs: { autocomplete: 'off' },
  });
  const featureSuggestions = SuggestList({
    hidden: true,
    ariaLabel: t('highlight.features'),
    attrs: { 'data-role': 'highlight-feature-suggestions' },
  });
  const featureError = FieldError({ text: t('refusal.highlight.featuresRequired'), hidden: true });
  const form = el('form', { class: 'ds-FormGrid highlight-form', 'data-id': highlightId }, [
    Field({
      label: t('form.name'),
      htmlFor: 'hl-label',
      full: true,
      control: TextInput({ id: 'hl-label', name: 'label', value: highlight?.label ?? '', required: true }),
    }),
    Field({
      label: t('highlight.section'),
      htmlFor: 'hl-section',
      control: [
        TextInput({
          id: 'hl-section',
          name: 'section',
          value: highlight?.section ?? '',
          attrs: { list: 'hl-section-options' },
        }),
        el('datalist', { id: 'hl-section-options' }, sections().map((section) => el('option', { value: section }))),
      ],
    }),
    Field({
      label: t('highlight.icon'),
      htmlFor: 'hl-icon',
      control: TextInput({
        id: 'hl-icon',
        name: 'icon',
        value: highlight?.icon ?? '',
        attrs: { pattern: '[a-z0-9-]+' },
      }),
    }),
    Field({
      label: t('highlight.features'),
      htmlFor: 'hl-feature-search',
      full: true,
      control: [
        ChipBox({
          children: [
            featureChips,
            ChipBoxSlot({ children: [featureSearch, featureSuggestions] }),
          ],
        }),
        featureError,
      ],
    }),
    Field({
      label: t('feature.description'),
      htmlFor: 'hl-description',
      full: true,
      control: TextArea({ id: 'hl-description', name: 'description', value: highlight?.description ?? '' }),
    }),
    highlight
      ? Field({
          label: t('form.id'),
          hint: t('readOnly'),
          control: TextInput({ value: highlight.id, readonly: true }),
        })
      : null,
    FormActions({
      children: [
        Button({ label: t('form.save'), type: 'submit' }),
        highlight ? Button({ label: t('delete'), variant: 'danger', attrs: { 'data-action': 'delete' } }) : null,
      ],
    }),
  ]);

  hostApi().panel?.open({
    title: highlight?.label || t('highlight.new'),
    render: (container) => container.replaceChildren(form),
  });

  wireFeaturePicker(pricing.features, selected, featureChips, featureSearch, featureSuggestions, featureError);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveHighlight(highlight, form, featureError);
  });
  form.querySelector<HTMLButtonElement>('[data-action="delete"]')?.addEventListener('click', () => {
    if (highlight) void deleteHighlight(highlight);
  });
  form.querySelector<HTMLInputElement>('#hl-label')?.focus();
}

function wireFeaturePicker(
  features: ReturnType<typeof currentPricing>['features'],
  selected: Set<string>,
  chips: HTMLElement,
  input: HTMLInputElement,
  list: HTMLUListElement,
  error: HTMLElement,
): void {
  let current: typeof features = [];
  let activeIndex = -1;

  const close = () => {
    list.hidden = true;
    activeIndex = -1;
  };
  const candidates = () => {
    const query = input.value.trim().toLocaleLowerCase();
    return features.filter(
      (feature) => !selected.has(feature.id) && (!query || feature.name.toLocaleLowerCase().includes(query)),
    );
  };
  const renderChips = () => {
    const byId = new Map(features.map((feature) => [feature.id, feature]));
    chips.replaceChildren(
      ...[...selected].flatMap((id) => {
        const feature = byId.get(id);
        return [
          Chip({
            label: feature?.name ?? id,
            unlinked: !feature,
            removable: true,
            removeLabel: t('highlight.feature.remove.aria', { name: feature?.name ?? id }),
            onRemove: () => {
              selected.delete(id);
              renderChips();
              renderList();
              input.focus();
            },
          }),
          el('input', { type: 'hidden', name: 'featureIds', value: id }),
        ];
      }),
    );
  };
  const pick = (index: number) => {
    const feature = current[index];
    if (!feature) return;
    selected.add(feature.id);
    input.value = '';
    error.hidden = true;
    renderChips();
    renderList();
    input.focus();
  };
  const renderList = () => {
    current = candidates();
    activeIndex = -1;
    list.replaceChildren(
      ...(current.length
        ? current.map((feature, index) =>
            SuggestItem({
              label: feature.name,
              description: feature.group?.trim() || undefined,
              on: {
                mousedown: (event) => {
                  event.preventDefault();
                  pick(index);
                },
              },
            }),
          )
        : [SuggestEmpty({ text: t('empty.featureMatches') })]),
    );
    list.hidden = false;
  };

  renderChips();
  input.addEventListener('focus', renderList);
  input.addEventListener('input', renderList);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (list.hidden) renderList();
      activeIndex = Math.min(activeIndex + 1, current.length - 1);
      highlightSuggestion(list, activeIndex);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      highlightSuggestion(list, activeIndex);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (list.hidden) renderList();
      if (current.length) pick(activeIndex >= 0 ? activeIndex : 0);
    } else if (event.key === 'Escape') {
      close();
    } else if (event.key === 'Backspace' && !input.value && selected.size) {
      selected.delete([...selected].at(-1)!);
      renderChips();
      if (!list.hidden) renderList();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

async function saveHighlight(
  current: PricingHighlight | undefined,
  form: HTMLFormElement,
  featureError: HTMLElement,
): Promise<void> {
  const fd = new FormData(form);
  const label = String(fd.get('label') ?? '').trim();
  const featureIds = fd.getAll('featureIds').map(String);
  featureError.hidden = featureIds.length > 0;
  if (!label || !featureIds.length) return;
  const section = String(fd.get('section') ?? '').trim();
  const icon = String(fd.get('icon') ?? '').trim();
  const description = String(fd.get('description') ?? '').trim();
  const values = { label, featureIds, section: section || null, icon: icon || null, description: description || null };

  try {
    const saved = current
      ? await apiUpdateHighlight(current.id, values as Partial<PricingHighlight>, current.rowVersion)
      : await apiAddHighlight({
          id: slugId(label, currentPricing(file()).highlights?.map((highlight) => highlight.id) ?? [], 'highlight'),
          label,
          featureIds,
          ...(section ? { section } : {}),
          ...(icon ? { icon } : {}),
          ...(description ? { description } : {}),
        });
    applyRow(file(), PRICING_COLLECTIONS.highlights, saved);
    repaintPricingView();
    hostApi().panel?.close();
    status(t(current ? 'highlight.updated' : 'highlight.created', { name: label }));
  } catch (error) {
    if (error instanceof ConflictError) {
      status(t('refusal.highlight.conflict'));
      return;
    }
    status(t('refusal.saveFailed', { error: error instanceof Error ? error.message : String(error) }));
  }
}

async function deleteHighlight(highlight: PricingHighlight): Promise<void> {
  if (!confirm(t('highlight.deleteConfirm', { name: highlight.label }))) return;
  try {
    await apiDeleteHighlight(highlight.id);
    dropRow(file(), PRICING_COLLECTIONS.highlights, highlight.id);
    repaintPricingView();
    hostApi().panel?.close();
    status(t('highlight.deleted', { name: highlight.label }));
  } catch (error) {
    status(t('refusal.deleteFailed', { error: error instanceof Error ? error.message : String(error) }));
  }
}

export async function moveHighlight(id: string, anchor: { before?: string; after?: string }): Promise<void> {
  try {
    const highlights = currentPricing(file()).highlights ?? [];
    const anchorId = anchor.before ?? anchor.after;
    if (!anchorId) return;
    await moveHighlightRows(highlights, id, anchorId, apiMoveHighlight, (order) => {
      orderRows(file(), PRICING_COLLECTIONS.highlights, order);
    });
    repaintPricingView();
  } catch (error) {
    status(t('refusal.highlight.moveFailed', { error: error instanceof Error ? error.message : String(error) }));
  }
}
