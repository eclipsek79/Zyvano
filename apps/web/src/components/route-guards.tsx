/**
 * Route guards.
 *
 * These exist for user experience, not security: every endpoint re-authorizes
 * independently. A guard only prevents rendering a screen whose data would fail
 * to load, and preserves the attempted path so sign-in can return the user there.
 */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '../state/auth-context';
import { LoadingState } from './ui';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { authenticated, initializing } = useAuth();
  const location = useLocation();

  // While the session probe is in flight neither branch is correct: rendering the
  // sign-in form would flash for a signed-in user on every refresh.
  if (initializing) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <LoadingState label="Restoring your session…" />
      </div>
    );
  }

  if (!authenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
}

/**
 * Blocks an action (not a route) until the address is verified.
 *
 * Returns the child only when verified; otherwise renders the explanation the
 * caller supplied, keeping the reason visible where the user tried to act.
 */
export function RequireVerifiedEmail({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const { user } = useAuth();
  if (!user?.emailVerified) return <>{fallback}</>;
  return <>{children}</>;
}
