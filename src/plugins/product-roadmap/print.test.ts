import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printPricingView } from './print';

test('pricing PDF export delegates to the browser print dialog', () => {
  let calls = 0;
  printPricingView(() => calls++);
  assert.equal(calls, 1);
});
