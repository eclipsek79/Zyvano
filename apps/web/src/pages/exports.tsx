/**
 * Workspace export history.
 *
 * Lists every render across projects. Downloads are only offered for rows the
 * backend reports as completed and verified; the link itself is minted on demand.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { ExportDTO } from '@zyvano/shared';

import { PageHeader } from '../components/app-layout';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  LoadingState,
  Progress,
  SelectField,
  StatusBadge,
  formatBytes,
  formatDuration,
  relativeTime,
  useToast,
} from '../components/ui';
import { exportsApi } from '../lib/api';
import { ApiError } from '../lib/api-client';
import { useAsync, useLiveActivity, usePolling } from '../hooks/use-async';
import { useAuth } from '../state/auth-context';

const STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'queued', label: 'Queued' },
  { value: 'processing', label: 'Processing' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function ExportsPage() {
  const { push } = useToast();
  const { activeOrganization } = useAuth();

  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const exportsState = useAsync(
    () =>
      exportsApi.list({
        ...(status ? { status } : {}),
        page,
        perPage: 20,
        sort: 'createdAt',
        order: 'desc',
      }),
    [activeOrganization?.id, status, page],
  );

  const items = exportsState.data?.items ?? [];
  const meta = exportsState.data?.meta;
  const live = useLiveActivity(items);

  const { data: polled } = usePolling(
    () =>
      exportsApi.list({
        ...(status ? { status } : {}),
        page,
        perPage: 20,
        sort: 'createdAt',
        order: 'desc',
      }),
    live,
    3000,
  );

  const list = polled?.items ?? items;

  async function download(row: ExportDTO) {
    setDownloadingId(row.id);
    try {
      const link = await exportsApi.download(row.id);
      window.open(link.url, '_blank', 'noopener,noreferrer');
      push('success', `Download started · link valid until ${relativeTime(link.expiresAt)} from now.`);
    } catch (caught) {
      push(
        'error',
        caught instanceof ApiError ? caught.message : 'The download link could not be created.',
      );
      await exportsState.reload();
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div className="stack stack-5">
      <PageHeader
        title="Exports"
        subtitle="Rendered master files across every project in this workspace."
      />

      <section className="card">
        <div className="card-body card-body--tight row row-3 row-wrap">
          <div style={{ minWidth: 200 }}>
            <SelectField
              label="Status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
              options={STATUS_OPTIONS}
            />
          </div>
          <div className="grow" />
          <Button onClick={() => void exportsState.reload()} loading={exportsState.loading}>
            Refresh
          </Button>
        </div>
      </section>

      {exportsState.error ? (
        <Alert tone="danger">Exports could not be loaded: {exportsState.error.message}</Alert>
      ) : null}

      {exportsState.initialLoading ? (
        <div className="card">
          <LoadingState label="Loading exports…" />
        </div>
      ) : list.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="⤓"
            title="No exports yet"
            description="Open a project and queue an export from its Exports tab. Completed renders appear here with a verified download link."
          />
        </div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Preset</th>
                <th>Progress</th>
                <th>Output</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td>
                    <Badge tone="neutral">{row.preset}</Badge>
                  </td>
                  <td style={{ minWidth: 140 }}>
                    {row.status === 'queued' || row.status === 'processing' ? (
                      <div className="stack stack-1">
                        <Progress value={row.progress} />
                        <span className="text-xs faint">{row.progress}%</span>
                      </div>
                    ) : row.status === 'failed' ? (
                      <span className="text-xs" style={{ color: 'var(--danger)' }}>
                        {row.errorMessage ?? 'Render failed.'}
                      </span>
                    ) : (
                      <span className="text-xs faint">—</span>
                    )}
                  </td>
                  <td className="text-xs faint">
                    {row.files && row.files.length > 0
                      ? `${formatBytes(
                          row.files.find((file) => file.kind === 'video')?.sizeBytes ??
                            row.files[0]?.sizeBytes ??
                            null,
                        )}${
                          row.files.find((file) => file.kind === 'video')?.durationSeconds
                            ? ` · ${formatDuration(
                                row.files.find((file) => file.kind === 'video')!.durationSeconds,
                              )}`
                            : ''
                        }`
                      : row.verified
                        ? 'Verified'
                        : 'Not verified yet'}
                  </td>
                  <td className="text-xs faint">{relativeTime(row.createdAt)}</td>
                  <td className="text-right">
                    <div className="row row-2 row-end">
                      <Link to={`/projects/${row.projectId}`} className="btn btn--sm">
                        Project
                      </Link>
                      {row.status === 'completed' ? (
                        <Button
                          size="sm"
                          variant="primary"
                          loading={downloadingId === row.id}
                          onClick={() => download(row)}
                        >
                          Download
                        </Button>
                      ) : null}
                      {row.status === 'failed' ? (
                        <Button
                          size="sm"
                          onClick={async () => {
                            try {
                              await exportsApi.retry(row.id);
                              push('success', 'Export re-queued.');
                              await exportsState.reload();
                            } catch (caught) {
                              push(
                                'error',
                                caught instanceof ApiError ? caught.message : 'Retry failed.',
                              );
                            }
                          }}
                        >
                          Retry
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {meta && meta.totalPages > 1 ? (
            <div className="card-footer row row-between">
              <span className="text-xs faint">
                Page {meta.page} of {meta.totalPages} · {meta.total} exports
              </span>
              <div className="row row-2">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button
                  size="sm"
                  disabled={page >= meta.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
