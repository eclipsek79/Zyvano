/**
 * The authenticated application chrome: sidebar navigation, workspace switcher,
 * account menu and notification indicator.
 */
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';

import { Badge, Button, relativeTime, useToast } from './ui';
import { useAuth } from '../state/auth-context';
import { notificationsApi } from '../lib/api';
import { usePolling } from '../hooks/use-async';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: '◧', end: true },
  { to: '/assets', label: 'Asset library', icon: '▤', end: false },
  { to: '/exports', label: 'Exports', icon: '⤓', end: false },
  { to: '/activity', label: 'Activity', icon: '≡', end: false },
  { to: '/settings', label: 'Settings', icon: '⚙', end: false },
] as const;

export function AppLayout() {
  const { user, organizations, activeOrganization, switchOrganization, logout } = useAuth();
  const navigate = useNavigate();
  const { push } = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Unread notifications are the only always-on poll in the shell. It is a small
  // count endpoint and gives the operator a signal that an async job finished.
  const { data: unread } = usePolling(
    () => notificationsApi.unreadCount(),
    Boolean(user),
    20_000,
  );

  useEffect(() => {
    setSidebarOpen(false);
  }, [navigate]);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch {
      push('error', 'Sign out failed. Your session may still be active — retry.');
    } finally {
      setSigningOut(false);
    }
  }

  const unreadCount = unread?.count ?? 0;

  return (
    <div className="app-shell">
      {sidebarOpen ? (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <aside className="app-sidebar" data-open={sidebarOpen}>
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            Z
          </div>
          <div className="stack">
            <span className="brand-name">Zyvano</span>
            <span className="brand-sub">AI video studio</span>
          </div>
        </div>

        {organizations.length > 0 ? (
          <div className="stack stack-1">
            <label className="nav-label" htmlFor="workspace-switcher">
              Workspace
            </label>
            <select
              id="workspace-switcher"
              className="select"
              value={activeOrganization?.id ?? ''}
              onChange={(event) => switchOrganization(event.target.value)}
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                  {org.role ? ` · ${org.role}` : ''}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <nav className="nav-group" aria-label="Main">
          <span className="nav-label">Studio</span>
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="nav-link">
              <span aria-hidden="true">{item.icon}</span>
              <span className="nav-link-text">{item.label}</span>
              {item.to === '/activity' && unreadCount > 0 ? (
                <Badge tone="accent">{unreadCount}</Badge>
              ) : null}
            </NavLink>
          ))}
        </nav>

        <div className="grow" />

        <div className="stack stack-2">
          <div className="panel stack stack-1">
            <span className="text-xs muted truncate" title={user?.email}>
              {user?.displayName ?? 'Account'}
            </span>
            <span className="text-xs faint truncate">{user?.email}</span>
            {user && !user.emailVerified ? (
              <Badge tone="warning">Email unverified</Badge>
            ) : (
              <Badge tone="success">Verified</Badge>
            )}
          </div>
          <Button variant="ghost" size="sm" block onClick={handleSignOut} loading={signingOut}>
            Sign out
          </Button>
        </div>
      </aside>

      <div className="app-main">
        <header className="app-header">
          <Button
            variant="ghost"
            size="sm"
            className="sidebar-toggle"
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            ☰
          </Button>
          <div className="grow truncate">
            <span className="text-sm muted">
              {activeOrganization?.name ?? 'Zyvano'}
            </span>
          </div>
          {user && !user.emailVerified ? (
            <Badge tone="warning">Verify your email to generate</Badge>
          ) : null}
        </header>

        <main className="app-content app-content--wide">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Shared header used by every top-level page. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="row row-between row-wrap stack-3" style={{ marginBottom: 'var(--space-5)' }}>
      <div className="stack stack-1">
        <h1>{title}</h1>
        {subtitle ? <p className="muted text-sm">{subtitle}</p> : null}
      </div>
      {actions ? <div className="row row-2 row-wrap">{actions}</div> : null}
    </div>
  );
}

export { relativeTime };
