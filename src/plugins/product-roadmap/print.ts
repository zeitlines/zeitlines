/** Open the browser's print dialog for the active pricing view. The print stylesheet
 * expands the view before the browser offers PDF output. */
export function printPricingView(print: () => void = () => window.print()): void {
  print();
}
