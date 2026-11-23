const LEGACY_PERSISTENT_GUEST_KEYS = [
  'velura_guest_session_id',
  'velura_guest_wishlist',
  'velura_wishlist_count',
  'velura_chat_guest_id',
  'velura_chat_session_id',
  'velura_chat_session_owner',
  'checkout_shipping',
  'checkout_methods',
  'checkout_discount',
  'checkout_voucher_id',
  'checkout_voucher_code',
  'checkout_voucher_declined',
  'created_order',
  'selected_cart_items',
  'velura_recently_viewed',
  'velura_liked_reviews',
  'velura_suggestions_enabled',
] as const;

/** Removes browser-global guest artifacts left by releases that predate tab isolation. */
export function clearLegacyPersistentGuestState(): void {
  if (typeof localStorage === 'undefined') return;
  for (const key of LEGACY_PERSISTENT_GUEST_KEYS) localStorage.removeItem(key);
}

/** Tab-scoped identity shared by guest quiz and APIs; never restore a prior persistent browser identity. */
export function guestSessionId(): string {
  if (typeof sessionStorage === 'undefined') {
    return 'gs_test_session';
  }
  let id = sessionStorage.getItem('velura_guest_session_id');
  if (!id) {
    id = `gs_${crypto.randomUUID()}`;
    sessionStorage.setItem('velura_guest_session_id', id);
  }
  clearLegacyPersistentGuestState();
  return id;
}

/** Logout/account changes cannot resume the previous customer's guest profile stored by the API. */
export function rotateGuestSession(): void {
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem('velura_guest_session_id');
  }
  guestSessionId();
}
