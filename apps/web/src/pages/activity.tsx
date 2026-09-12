/**
 * Activity feed and notifications.
 *
 * Two real streams live here: the notification list addressed to the signed-in
 * user, and (for roles that may read it) the organization audit trail. Neither is
 * synthesised — an empty feed means nothing has happened yet.
 */
import { useState } from 'react';

import type { AuditEventDTO } from '@zyvano/shared';

import { PageHeader } from '../components/app-layout';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  LoadingState,
  SelectField,
  Tabs,
  relativeTime,
  useToast,
} from '../components/ui';
import { auditApi, notificationsApi } from '../lib/api';
import { ApiError } from '../lib/api-client';
import { useAsync } from '../hooks/use-async';
import { usePermissions } from '../state/auth-context';

type TabId = 'notifications' | 'audit';

const AUDIT_CATEGORIES = [
  { value: '', label: 'All categories' },
  { value: 'auth', label: 'Authentication' },
  { value: 'authorization', label: 'Authorization' },
  { value: 'project', label: 'Projects' },
  { value: 'generation', label: 'Generations' },
  { value: 'export', label: 'Exports' },
  { value: 'asset', label: 'Assets' },
  { value: 'destructive', label: 'Destructive' },
  { value: 'admin', label: 'Administration' },
  { value: 'system', label: 'System' },
];

export function ActivityPage() {
  const { push } = useToast();
  const { canReadAudit } = usePermissions();

  const [tab, setTab] = useState<TabId>('notifications');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [working, setWorking] = useState(false);

  const notifications = useAsync(() => notificationsApi.list(), []);
  const audit = useAsync(
    () =>
      auditApi.list({
        ...(category ? { category } : {}),
        page,
        perPage: 40,
        sort: 'createdAt',
        order: 'desc',
      }),
    [category, page],
    { enabled: tab === 'audit' && canReadAudit },
  );

  const unreadCount = (notifications.data ?? []).filter((item) => item.readAt === null).length;

  async function markAllRead() {
    setWorking(true);
    try {
      await notificationsApi.markAllRead();
      await notifications.reload();
      push('success', 'All notifications marked as read.');
    } catch (caught) {
      push('error', caught instanceof ApiError ? caught.message : 'Could not update notifications.');
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="stack stack-5">
      <PageHeader
        title="Activity"
        subtitle="Notifications addressed to you, and the workspace audit trail."
      />

      <Tabs<TabId>
        tabs={[
          { id: 'notifications', label: 'Notifications', count: unreadCount },
          ...(canReadAudit ? [{ id: 'audit' as const, label: 'Audit trail' }] : []),
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'notifications' ? (
        <section className="card">
          <div className="card-header">
            <h2 className="grow">Notifications</h2>
            <Button
              size="sm"
              onClick={markAllRead}
              loading={working}
              disabled={unreadCount === 0}
            >
              Mark all read
            </Button>
          </div>

          {notifications.error ? (
            <div className="card-body">
              <Alert tone="danger">{notifications.error.message}</Alert>
            </div>
          ) : notifications.initialLoading ? (
            <LoadingState label="Loading notifications…" />
          ) : (notifications.data ?? []).length === 0 ? (
            <EmptyState
              icon="◔"
              title="No notifications"
              description="You will be told here when an asynchronous generation or export finishes, or when someone shares work with you."
            />
          ) : (
            <div className="card-body card-body--tight stack stack-2">
              {(notifications.data ?? []).map((item) => (
                <div
                  key={item.id}
                  className="panel row row-3 row-between"
                  style={{ alignItems: 'flex-start' }}
                >
                  <div className="grow stack stack-1">
                    <span className="row row-2">
                      <strong className="text-sm">{item.title}</strong>
                      {item.readAt === null ? <Badge tone="accent">New</Badge> : null}
                    </span>
                    {item.body ? <p className="text-sm muted">{item.body}</p> : null}
                    <span className="text-xs faint">{relativeTime(item.createdAt)}</span>
                  </div>
                  {item.readAt === null ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await notificationsApi.markRead(item.id);
                          await notifications.reload();
                        } catch (caught) {
                          push(
                            'error',
                            caught instanceof ApiError ? caught.message : 'Could not mark as read.',
                          );
                        }
                      }}
                    >
                      Mark read
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="card">
          <div className="card-header">
            <h2 className="grow">Audit trail</h2>
            <div style={{ minWidth: 200 }}>
              <SelectField
                label=""
                value={category}
                onChange={(event) => {
                  setCategory(event.target.value);
                  setPage(1);
                }}
                options={AUDIT_CATEGORIES}
              />
            </div>
          </div>

          {audit.error ? (
            <div className="card-body">
              <Alert tone="danger">{audit.error.message}</Alert>
            </div>
          ) : audit.initialLoading ? (
            <LoadingState label="Loading audit events…" />
          ) : (audit.data?.items ?? []).length === 0 ? (
            <EmptyState
              icon="≡"
              title="No audit events"
              description="Security-relevant actions — sign-ins, permission changes, destructive operations and provider failures — are recorded here."
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Category</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Resource</th>
                </tr>
              </thead>
              <tbody>
                {(audit.data?.items ?? []).map((event: AuditEventDTO) => (
                  <tr key={event.id}>
                    <td className="text-xs faint nowrap">{relativeTime(event.createdAt)}</td>
                    <td>
                      <Badge tone="neutral">{event.category}</Badge>
                    </td>
                    <td className="mono">{event.action}</td>
                    <td className="text-xs muted truncate">{event.actorEmail ?? 'system'}</td>
                    <td className="text-xs faint truncate">
                      {event.resourceType ?? '—'}
                      {event.resourceId ? ` · ${event.resourceId.slice(0, 8)}…` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
