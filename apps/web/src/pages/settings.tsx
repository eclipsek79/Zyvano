/**
 * Account and workspace settings.
 *
 * Covers the profile, password change, workspace membership and — for permitted
 * roles — the usage summary the server reports for the billing period.
 */
import { useState, type FormEvent } from 'react';

import { ORG_ROLES, type OrgRole, type ProjectMemberDTO } from '@zyvano/shared';

import { PageHeader } from '../components/app-layout';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  SelectField,
  Tabs,
  TextField,
  relativeTime,
  useToast,
} from '../components/ui';
import { authApi, organizationsApi, usageApi, usersApi } from '../lib/api';
import type { OrganizationInvitation } from '../lib/api';
import { ApiError } from '../lib/api-client';
import { useAsync } from '../hooks/use-async';
import { useAuth, usePermissions } from '../state/auth-context';

type TabId = 'profile' | 'workspace' | 'usage';

export function SettingsPage() {
  const { user, activeOrganization, refresh } = useAuth();
  const { canManageMembers, canManageProjects, canReadUsage } = usePermissions();
  const { push } = useToast();

  const [tab, setTab] = useState<TabId>('profile');

  const members = useAsync(
    () => organizationsApi.members(activeOrganization!.id),
    [activeOrganization?.id],
    { enabled: Boolean(activeOrganization) && tab === 'workspace' },
  );

  const invitations = useAsync(
    () => organizationsApi.invitations(activeOrganization!.id),
    [activeOrganization?.id],
    { enabled: Boolean(activeOrganization) && tab === 'workspace' && canManageMembers },
  );

  const usage = useAsync(() => usageApi.summary(30), [activeOrganization?.id], {
    enabled: Boolean(activeOrganization) && tab === 'usage' && canReadUsage,
  });

  return (
    <div className="stack stack-5">
      <PageHeader title="Settings" subtitle="Your account, your workspace and recorded usage." />

      <Tabs<TabId>
        tabs={[
          { id: 'profile', label: 'Profile' },
          { id: 'workspace', label: 'Workspace' },
          ...(canReadUsage ? [{ id: 'usage' as const, label: 'Usage' }] : []),
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'profile' ? <ProfilePanel onSaved={() => void refresh()} /> : null}

      {tab === 'workspace' ? (
        <WorkspacePanel
          organizationId={activeOrganization?.id ?? ''}
          organizationName={activeOrganization?.name ?? ''}
          role={activeOrganization?.role ?? null}
          members={members}
          invitations={invitations}
          canManage={canManageMembers}
          canRename={canManageProjects}
          currentUserId={user?.id ?? ''}
          onChanged={() => {
            void members.reload();
            void invitations.reload();
          }}
          onOrganizationRenamed={() => void refresh()}
          push={push}
        />
      ) : null}

      {tab === 'usage' ? (
        <section className="card">
          <div className="card-header">
            <h2 className="grow">Usage · last 30 days</h2>
            <Button size="sm" onClick={() => void usage.reload()}>
              Refresh
            </Button>
          </div>
          {usage.error ? (
            <div className="card-body">
              <Alert tone="danger">{usage.error.message}</Alert>
            </div>
          ) : usage.initialLoading ? (
            <LoadingState label="Loading usage…" />
          ) : !usage.data ? (
            <EmptyState icon="◔" title="No usage data" />
          ) : (
            <div className="card-body stack stack-5">
              <div className="grid grid--stats">
                <div className="stat">
                  <div className="stat-label">Credits used</div>
                  <div className="stat-value">{usage.data.creditsUsed}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">Credits remaining</div>
                  <div className="stat-value">{usage.data.creditsRemaining}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">Quota</div>
                  <div className="stat-value">{usage.data.quota}</div>
                </div>
              </div>

              <div className="stack stack-2">
                <h3>By capability</h3>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Capability</th>
                      <th className="text-right">Requests</th>
                      <th className="text-right">Units</th>
                      <th className="text-right">Credits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(usage.data.byCapability).map(([key, stats]) => (
                      <tr key={key}>
                        <td style={{ textTransform: 'capitalize' }}>{key}</td>
                        <td className="text-right mono">{stats.requests}</td>
                        <td className="text-right mono">{stats.units}</td>
                        <td className="text-right mono">{stats.credits}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="stack stack-2">
                <h3>By provider</h3>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th className="text-right">Requests</th>
                      <th className="text-right">Units</th>
                      <th className="text-right">Credits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(usage.data.byProvider).map(([key, stats]) => (
                      <tr key={key}>
                        <td>{key}</td>
                        <td className="text-right mono">{stats.requests}</td>
                        <td className="text-right mono">{stats.units}</td>
                        <td className="text-right mono">{stats.credits}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

/* -------------------------------- profile --------------------------------- */

function ProfilePanel({ onSaved }: { onSaved: () => void }) {
  const { user, refresh } = useAuth();
  const { push } = useToast();

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [resending, setResending] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setSavingProfile(true);
    try {
      await usersApi.updateProfile({ displayName: displayName.trim() });
      push('success', 'Profile updated.');
      onSaved();
    } catch (caught) {
      push('error', caught instanceof ApiError ? caught.message : 'Profile update failed.');
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setPasswordError(null);
    setSavingPassword(true);
    try {
      await authApi.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      push('success', 'Password changed. Other sessions were kept active.');
    } catch (caught) {
      setPasswordError(caught instanceof ApiError ? caught.message : 'Password change failed.');
    } finally {
      setSavingPassword(false);
    }
  }

  async function revokeAll() {
    setRevoking(true);
    try {
      await authApi.revokeAllSessions();
      push('success', 'All other sessions were revoked.');
      setConfirmRevoke(false);
      await refresh();
    } catch (caught) {
      push('error', caught instanceof ApiError ? caught.message : 'Could not revoke sessions.');
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="grid grid--two">
      <section className="card">
        <div className="card-header">
          <h2 className="grow">Profile</h2>
          {user?.emailVerified ? (
            <Badge tone="success">Verified</Badge>
          ) : (
            <Badge tone="warning">Unverified</Badge>
          )}
        </div>
        <div className="card-body stack stack-4">
          <form className="stack stack-4" onSubmit={saveProfile} noValidate>
            <TextField
              label="Display name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
            <TextField label="Email" value={user?.email ?? ''} disabled readOnly />
            <Button type="submit" variant="primary" loading={savingProfile}>
              Save profile
            </Button>
          </form>

          {!user?.emailVerified ? (
            <Alert
              tone="warning"
              action={
                <Button
                  size="sm"
                  loading={resending}
                  onClick={async () => {
                    setResending(true);
                    try {
                      await authApi.resendVerification();
                      push('success', 'Verification email sent.');
                    } catch (caught) {
                      push(
                        'error',
                        caught instanceof ApiError ? caught.message : 'Could not send the email.',
                      );
                    } finally {
                      setResending(false);
                    }
                  }}
                >
                  Resend
                </Button>
              }
            >
              Your email is not verified. Generation and uploads are blocked until it is.
            </Alert>
          ) : null}
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="grow">Security</h2>
        </div>
        <div className="card-body stack stack-4">
          <form className="stack stack-4" onSubmit={changePassword} noValidate>
            {passwordError ? <Alert tone="danger">{passwordError}</Alert> : null}
            <TextField
              label="Current password"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
            <TextField
              label="New password"
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              hint="At least 10 characters, with a letter and a number."
            />
            <Button type="submit" variant="primary" loading={savingPassword}>
              Change password
            </Button>
          </form>

          <hr className="divider" />

          <div className="stack stack-2">
            <h3>Active sessions</h3>
            <p className="text-sm muted">
              Revoking signs out every other device. This session stays active.
            </p>
            <Button variant="danger" onClick={() => setConfirmRevoke(true)}>
              Revoke all other sessions
            </Button>
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={confirmRevoke}
        title="Revoke all other sessions?"
        message="Every other signed-in device is signed out immediately. You will stay signed in here."
        confirmLabel="Revoke sessions"
        busy={revoking}
        onConfirm={revokeAll}
        onCancel={() => setConfirmRevoke(false)}
      />
    </div>
  );
}

/* ------------------------------- workspace -------------------------------- */

function WorkspacePanel({
  organizationId,
  organizationName,
  role,
  members,
  invitations,
  canManage,
  canRename,
  currentUserId,
  onChanged,
  onOrganizationRenamed,
  push,
}: {
  organizationId: string;
  organizationName: string;
  role: OrgRole | null;
  /** Read-only views of the loaded state: this panel never mutates them directly. */
  members: {
    data: readonly ProjectMemberDTO[] | null;
    error: Error | null;
    initialLoading: boolean;
  };
  invitations: {
    data: readonly OrganizationInvitation[] | null;
    error: Error | null;
    initialLoading: boolean;
  };
  canManage: boolean;
  canRename: boolean;
  currentUserId: string;
  onChanged: () => void;
  onOrganizationRenamed: () => void;
  push: (tone: 'info' | 'success' | 'error', message: string) => void;
}) {
  const [name, setName] = useState(organizationName);
  const [savingName, setSavingName] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<OrgRole, 'owner'>>('member');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ProjectMemberDTO | null>(null);
  const [busy, setBusy] = useState(false);

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSavingName(true);
    try {
      await organizationsApi.update(organizationId, { name: name.trim() });
      push('success', 'Workspace renamed.');
      onOrganizationRenamed();
    } catch (caught) {
      push('error', caught instanceof ApiError ? caught.message : 'Rename failed.');
    } finally {
      setSavingName(false);
    }
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    setInviteError(null);
    setInviting(true);
    try {
      await organizationsApi.invite(organizationId, { email: inviteEmail, role: inviteRole });
      push('success', `Invitation sent to ${inviteEmail}.`);
      setInviteEmail('');
      onChanged();
    } catch (caught) {
      setInviteError(caught instanceof ApiError ? caught.message : 'Invitation failed.');
    } finally {
      setInviting(false);
    }
  }

  return (
    <div className="grid grid--two">
      <section className="card">
        <div className="card-header">
          <h2 className="grow">Workspace</h2>
          {role ? <Badge tone="accent">{role}</Badge> : null}
        </div>
        <div className="card-body stack stack-5">
          <form className="stack stack-3" onSubmit={rename} noValidate>
            <TextField
              label="Workspace name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={!canRename}
            />
            <Button type="submit" loading={savingName} disabled={!canRename}>
              Save name
            </Button>
          </form>

          <hr className="divider" />

          <div className="stack stack-3">
            <h3>Members</h3>
            {members.error ? (
              <Alert tone="danger">{members.error.message}</Alert>
            ) : members.initialLoading ? (
              <LoadingState label="Loading members…" />
            ) : (members.data ?? []).length === 0 ? (
              <p className="muted text-sm">No members found.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    <th>Added</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(members.data ?? []).map((member) => (
                    <tr key={member.userId}>
                      <td>
                        <div className="stack stack-1">
                          <span className="text-sm">{member.displayName}</span>
                          <span className="text-xs faint">{member.email}</span>
                        </div>
                      </td>
                      <td>
                        {canManage && member.role !== 'owner' && member.userId !== currentUserId ? (
                          <select
                            className="select"
                            value={member.role}
                            aria-label={`Role for ${member.email}`}
                            onChange={async (event) => {
                              setBusy(true);
                              try {
                                await organizationsApi.changeMemberRole(
                                  organizationId,
                                  member.userId,
                                  event.target.value as Exclude<OrgRole, 'owner'>,
                                );
                                push('success', 'Role updated.');
                                onChanged();
                              } catch (caught) {
                                push(
                                  'error',
                                  caught instanceof ApiError ? caught.message : 'Update failed.',
                                );
                                onChanged();
                              } finally {
                                setBusy(false);
                              }
                            }}
                            disabled={busy}
                          >
                            {ORG_ROLES.filter((r) => r !== 'owner').map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <Badge tone="neutral">{member.role}</Badge>
                        )}
                      </td>
                      <td className="text-xs faint">{relativeTime(member.addedAt)}</td>
                      <td className="text-right">
                        {canManage && member.role !== 'owner' && member.userId !== currentUserId ? (
                          <Button size="sm" variant="danger" onClick={() => setConfirmRemove(member)}>
                            Remove
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="grow">Invitations</h2>
        </div>
        <div className="card-body stack stack-4">
          {!canManage ? (
            <Alert tone="info">Only owners and admins can invite people.</Alert>
          ) : (
            <form className="stack stack-3" onSubmit={invite} noValidate>
              {inviteError ? <Alert tone="danger">{inviteError}</Alert> : null}
              <TextField
                label="Email"
                type="email"
                required
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
              <SelectField
                label="Role"
                value={inviteRole}
                onChange={(event) =>
                  setInviteRole(event.target.value as Exclude<OrgRole, 'owner'>)
                }
                options={ORG_ROLES.filter((r) => r !== 'owner').map((r) => ({
                  value: r,
                  label: r,
                }))}
              />
              <Button type="submit" variant="primary" loading={inviting}>
                Send invitation
              </Button>
            </form>
          )}

          <hr className="divider" />

          <div className="stack stack-3">
            <h3>Pending</h3>
            {!canManage ? null : (invitations.data ?? []).length === 0 ? (
              <p className="muted text-sm">No pending invitations.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Expires</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(invitations.data ?? []).map((invitation) => (
                    <tr key={invitation.id}>
                      <td className="text-sm truncate">{invitation.email}</td>
                      <td>
                        <Badge tone="neutral">{invitation.role}</Badge>
                      </td>
                      <td className="text-xs faint">{relativeTime(invitation.expiresAt)}</td>
                      <td className="text-right">
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={async () => {
                            try {
                              await organizationsApi.revokeInvitation(
                                organizationId,
                                invitation.id,
                              );
                              push('success', 'Invitation revoked.');
                              onChanged();
                            } catch (caught) {
                              push(
                                'error',
                                caught instanceof ApiError ? caught.message : 'Revoke failed.',
                              );
                            }
                          }}
                        >
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={confirmRemove !== null}
        title="Remove this member?"
        message="They immediately lose access to every project in this workspace. Their generations and exports are kept."
        confirmLabel="Remove member"
        busy={busy}
        onConfirm={async () => {
          if (!confirmRemove) return;
          setBusy(true);
          try {
            await organizationsApi.removeMember(organizationId, confirmRemove.userId);
            push('success', 'Member removed.');
            setConfirmRemove(null);
            onChanged();
          } catch (caught) {
            push('error', caught instanceof ApiError ? caught.message : 'Removal failed.');
          } finally {
            setBusy(false);
          }
        }}
        onCancel={() => setConfirmRemove(null)}
      />
    </div>
  );
}
