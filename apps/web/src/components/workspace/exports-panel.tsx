/**
 * Project export queue.
 *
 * An export is only ever presented as finished when the backend reports a
 * completed render *and* the download endpoint returns a real file. Until then the
 * row shows the worker's own status and progress.
 */
import { useEffect, useMemo, useState } from 'react';

import type { ExportDTO, ExportPreset, ProjectDTO } from '@zyvano/shared';
import { EXPORT_PRESETS } from '@zyvano/shared';

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
} from '../ui';
import { exportsApi } from '../../lib/api';
import { ApiError } from '../../lib/api-client';
import { useAsync, useLiveActivity, usePolling } from '../../hooks/use-async';
import { usePermissions } from '../../state/auth-context';

export function ExportsPanel({ project }: { project: ProjectDTO }) {
  const { push } = useToast();
  const { canExport } = usePermissions();

  const [preset, setPreset] = useState<ExportPreset>('web-1080p');
  const [includeAudio, setIncludeAudio] = useState(true);
  const [queuing, setQueuing] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const exportsState = useAsync(
    () => exportsApi.list({ projectId: project.id, perPage: 20, sort: 'createdAt', order: 'desc' }),
    [project.id],
  );

  const items = exportsState.data?.items ?? [];
  const live = useLiveActivity(items);

  const { data: polled } = usePolling(
    () => exportsApi.list({ projectId: project.id, perPage: 20, sort: 'createdAt', order: 'desc' }),
    live,
    3000,
  );

  const list = polled?.items ?? items;

  // When the queue settles, refresh the list so a completed render's file metadata
  // (size, duration, thumbnail) replaces the in-flight row.
  const settledSignature = useMemo(
    () => list.filter((item) => item.status === 'completed').map((item) => item.id).join(','),
    [list],
  );
  const [lastSignature, setLastSignature] = useState('');
  useEffect(() => {
    if (settledSignature && settledSignature !== lastSignature) {
      void exportsState.reload();
    }
    setLastSignature(settledSignature);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledSignature]);

  async function queueExport() {
    setQueuing(true);
    try {
      const result = await exportsApi.create(project.id, { preset, includeAudio });
      push(
        'success',
        result.deduplicated
          ? 'An identical export is already queued; tracking it.'
          : 'Export queued. The render runs on a worker.',
      );
      await exportsState.reload();
    } catch (caught) {
      push('error', describeExportError(caught));
    } finally {
      setQueuing(false);
    }
  }

  async function download(exportRow: ExportDTO) {
    setDownloadingId(exportRow.id);
    try {
      // The API mints a short-lived signed URL and verifies the file exists first.
      const link = await exportsApi.download(exportRow.id);
      window.open(link.url, '_blank', 'noopener,noreferrer');
      push('success', `Download started · expires ${relativeTime(link.expiresAt)} from now.`);
    } catch (caught) {
      push('error', describeExportError(caught));
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div className="grid grid--two">
      <section className="card">
        <div className="card-header">
          <h2 className="grow">Render an export</h2>
        </div>
        <div className="card-body stack stack-4">
          <p className="muted text-sm">
            Zyvano composes the project's scenes into a single video and writes the master file to
            object storage. The row below reports the worker's real state.
          </p>

          <SelectField
            label="Output quality"
            value={preset}
            onChange={(event) => setPreset(event.target.value as ExportPreset)}
            options={EXPORT_PRESETS.map((value) => ({ value, label: value }))}
          />

          <label className="checkbox">
            <input
              type="checkbox"
              checked={includeAudio}
              onChange={(event) => setIncludeAudio(event.target.checked)}
            />
            <span>Include the audio track</span>
          </label>

          <Button
            variant="primary"
            onClick={queueExport}
            loading={queuing}
            disabled={!canExport || live}
          >
            {live ? 'An export is in progress…' : 'Queue export'}
          </Button>

          {!canExport ? (
            <Alert tone="info">Your role does not allow starting exports.</Alert>
          ) : null}
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="grow">Exports</h2>
          <Button size="sm" variant="ghost" onClick={() => void exportsState.reload()}>
            Refresh
          </Button>
        </div>

        {exportsState.initialLoading ? (
          <LoadingState label="Loading exports…" />
        ) : list.length === 0 ? (
          <EmptyState
            icon="⤓"
            title="No exports yet"
            description="Render the project to produce a downloadable master file. Files expire according to the retention policy, so download them when they are ready."
          />
        ) : (
          <div className="card-body card-body--tight stack stack-3">
            {list.map((row) => (
              <div key={row.id} className="panel stack stack-3">
                <div className="row row-between row-wrap">
                  <span className="row row-2">
                    <StatusBadge status={row.status} />
                    <Badge tone="neutral">{row.preset}</Badge>
                  </span>
                  <span className="text-xs faint">{relativeTime(row.createdAt)}</span>
                </div>

                {row.status === 'queued' || row.status === 'processing' ? (
                  <div className="stack stack-2">
                    <Progress value={row.progress} />
                    <span className="text-xs faint">{row.progress}% complete</span>
                  </div>
                ) : null}

                {row.status === 'completed' ? (
                  <div className="stack stack-2">
                    <OutputSummary row={row} />
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => download(row)}
                      loading={downloadingId === row.id}
                    >
                      Download
                    </Button>
                  </div>
                ) : null}

                {row.status === 'failed' ? (
                  <Alert
                    tone="danger"
                    action={
                      <Button
                        size="sm"
                        onClick={async () => {
                          try {
                            await exportsApi.retry(row.id);
                            push('success', 'Export re-queued.');
                            await exportsState.reload();
                          } catch (caught) {
                            push('error', describeExportError(caught));
                          }
                        }}
                      >
                        Retry
                      </Button>
                    }
                  >
                    {row.errorMessage ?? 'The render failed.'}
                  </Alert>
                ) : null}

                {row.status === 'cancelled' ? (
                  <p className="text-xs faint">This export was cancelled.</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function describeExportError(caught: unknown): string {
  if (!(caught instanceof ApiError)) return 'The request failed unexpectedly.';
  switch (caught.code) {
    case 'CONFLICT':
      return 'This project has no rendered scenes yet. Render at least one scene before exporting.';
    case 'QUOTA_EXCEEDED':
      return 'This workspace has used its available credits for the period.';
    case 'RATE_LIMITED':
      return 'Too many requests. Wait a moment and retry.';
    case 'GONE':
      return 'That export file has expired and been removed. Queue a new render.';
    case 'NOT_FOUND':
      return 'The export no longer exists.';
    default:
      return caught.message;
  }
}

/**
 * Renders the real file facts of a finished export.
 *
 * Everything shown here comes from the export row the server returned — the
 * primary file's own size and duration, and whether the backend verified that the
 * file exists in storage. Nothing is estimated.
 */
function OutputSummary({ row }: { row: ExportDTO }) {
  const primary = row.files?.find((file) => file.kind === 'video') ?? row.files?.[0];

  return (
    <div className="stack stack-2">
      {primary?.url ? (
        <img
          src={primary.url}
          alt=""
          loading="lazy"
          style={{ width: '100%', borderRadius: 'var(--radius)' }}
        />
      ) : null}
      <div className="row row-2 row-wrap text-xs faint">
        <span>{row.resolution}</span>
        <span>{row.format.toUpperCase()}</span>
        {primary ? <span>{formatBytes(primary.sizeBytes)}</span> : null}
        {primary?.durationSeconds ? <span>{formatDuration(primary.durationSeconds)}</span> : null}
      </div>
      <div className="row row-2 row-wrap">
        {row.verified ? (
          <Badge tone="success">File verified</Badge>
        ) : (
          <Badge tone="warning">Not verified</Badge>
        )}
        {row.expiresAt ? (
          <span className="text-xs faint">expires {relativeTime(row.expiresAt)}</span>
        ) : null}
      </div>
    </div>
  );
}
