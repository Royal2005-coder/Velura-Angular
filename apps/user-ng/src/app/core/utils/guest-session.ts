/** Tab-scoped identity shared by guest quiz and APIs; never restore a prior persistent browser identity. */
export function guestSessionId(): string {
  let id = sessionStorage.getItem('velura_guest_session_id');
  if (!id) {
    id = `gs_${crypto.randomUUID()}`;
    sessionStorage.setItem('velura_guest_session_id', id);
  }
  localStorage.removeItem('velura_guest_session_id');
  return id;
}

/** Logout/account changes cannot resume the previous customer's guest profile stored by the API. */
export function rotateGuestSession(): void {
  sessionStorage.removeItem('velura_guest_session_id');
  guestSessionId();
}
