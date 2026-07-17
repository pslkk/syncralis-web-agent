export function textLocator(page, text) {
  return page
    .locator("a, button")
    .filter({ hasText: text })
    .first();
}
