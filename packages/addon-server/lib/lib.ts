export function supportsStorefront(
  storefronts: readonly string[] | undefined,
  storefront: string
): boolean {
  if (!storefronts) return false;
  return storefronts.includes('*') || storefronts.includes(storefront);
}
