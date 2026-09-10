/**
 * Workspace-wide asset library.
 *
 * Every asset is fetched through the authorized content endpoint, so the browser
 * never holds a durable storage reference.
 */
import { useState } from 'react';

import { ASSET_KINDS, type AssetDTO, type AssetKind } from '@zyvano/shared';

import { PageHeader } from '../components/app-layout';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  SelectField,
  formatBytes,
  relativeTime,
  useToast,
} from '../components/ui';
import { assetsApi } from '../lib/api';
import { ApiError } from '../lib/api-client';
import { useAsync } from '../hooks/use-async';
import { useAuth, usePermissions } from '../state/auth-context';

const SOURCE_OPTIONS = [
  { value: '', label: 'Any source' },
  { value: 'upload', label: 'Uploaded' },
  { value: 'generated', label: 'Generated' },
  { value: 'system', label: 'System' },
];

export function AssetLibraryPage() {
  const { push } = useToast();
  const { activeOrganization } = useAuth();
  const { canDelete } = usePermissions();

  const [kind, setKind] = useState('');
  const [source, setSource] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [confirmDelete, setConfirmDelete] = useState<AssetDTO | null>(null);
  const [deleting, setDeleting] = useState(false);

  const assets = useAsync(
    () =>
      assetsApi.list({
        ...(kind ? { kind } : {}),
        ...(source ? { source } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
        page,
        perPage: 36,
      }),
    [activeOrganization?.id, kind, source, search, page],
  );

  const items = assets.data?.items ?? [];
  const meta = assets.data?.meta;

  async function deleteAsset(asset: AssetDTO) {
    setDeleting(true);
    try {
      await assetsApi.remove(asset.id);
      push('success', 'Asset deleted.');
      setConfirmDelete(null);
      await assets.reload();
    } catch (caught) {
      push('error', caught instanceof ApiError ? caught.message : 'Delete failed.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="stack stack-5">
      <PageHeader
        title="Asset library"
        subtitle="Every uploaded and generated file in this workspace."
      />

      <section className="card">
        <div className="card-body card-body--tight">
          <div className="grid grid--two">
            <SelectField
              label="Kind"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
                setPage(1);
              }}
              options={[
                { value: '', label: 'Any kind' },
                ...ASSET_KINDS.map((value: AssetKind) => ({ value, label: value })),
              ]}
            />
            <SelectField
              label="Source"
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setPage(1);
              }}
              options={SOURCE_OPTIONS}
            />
          </div>
          <div className="row row-2" style={{ marginTop: 'var(--space-3)' }}>
            <input
              className="input"
              placeholder="Search by filename…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              aria-label="Search assets by filename"
            />
            <Button onClick={() => void assets.reload()} loading={assets.loading}>
              Refresh
            </Button>
          </div>
        </div>
      </section>

      {assets.error ? (
        <Alert tone="danger">Assets could not be loaded: {assets.error.message}</Alert>
      ) : null}

      {assets.initialLoading ? (
        <div className="card">
          <LoadingState label="Loading assets…" />
        </div>
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="▤"
            title={search || kind || source ? 'No assets match these filters' : 'No assets yet'}
            description={
              search || kind || source
                ? 'Try clearing a filter to widen the search.'
                : 'Upload media inside a project, or generate scenes — generated files land here automatically.'
            }
          />
        </div>
      ) : (
        <>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
            {items.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                organizationId={activeOrganization?.id ?? null}
                canDelete={canDelete}
                onDelete={() => setConfirmDelete(asset)}
              />
            ))}
          </div>

          {meta && meta.totalPages > 1 ? (
            <div className="row row-between">
              <span className="text-xs faint">
                Page {meta.page} of {meta.totalPages} · {meta.total} assets
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
        </>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this asset?"
        message="The file is removed from storage. Projects that referenced it lose the preview."
        confirmLabel="Delete asset"
        busy={deleting}
        onConfirm={() => (confirmDelete ? deleteAsset(confirmDelete) : undefined)}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

function AssetCard({
  asset,
  organizationId,
  canDelete,
  onDelete,
}: {
  asset: AssetDTO;
  organizationId: string | null;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const url = assetsApi.contentUrl(asset.id, organizationId);

  return (
    <figure className="asset-tile" style={{ margin: 0 }}>
      <div className="asset-thumb">
        {asset.kind === 'image' ? (
          <img src={url} alt={asset.filename} loading="lazy" />
        ) : asset.kind === 'video' ? (
          <video src={url} muted playsInline preload="metadata" />
        ) : (
          <span aria-hidden="true" style={{ fontSize: 28, opacity: 0.5 }}>
            {asset.kind === 'audio' ? '♪' : '▢'}
          </span>
        )}
      </div>
      <figcaption className="asset-meta">
        <span className="asset-name" title={asset.filename}>
          {asset.filename}
        </span>
        <div className="row row-2 row-wrap">
          <Badge tone={asset.source === 'generated' ? 'accent' : 'neutral'}>{asset.source}</Badge>
          <span className="text-xs faint">{formatBytes(asset.sizeBytes)}</span>
        </div>
        <span className="text-xs faint">{relativeTime(asset.createdAt)}</span>
        <div className="row row-2">
          <a className="btn btn--sm" href={url} target="_blank" rel="noreferrer">
            Open
          </a>
          {canDelete ? (
            <Button size="sm" variant="danger" onClick={onDelete}>
              Delete
            </Button>
          ) : null}
        </div>
      </figcaption>
    </figure>
  );
}
