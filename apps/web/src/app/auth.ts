/**
 * Sign-in. In http mode the BFF owns OIDC + PKCE, so the browser navigates to it and comes
 * back to `returnTo` (§5.1). The mock replaces this through mock-bootstrap so it can sign the
 * persona back in without leaving the page.
 */
let signInImpl = async (returnTo: string): Promise<void> => {
  window.location.assign(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
};

export function setSignIn(impl: (returnTo: string) => Promise<void>): void {
  signInImpl = impl;
}

export function signIn(returnTo: string): Promise<void> {
  return signInImpl(returnTo);
}
