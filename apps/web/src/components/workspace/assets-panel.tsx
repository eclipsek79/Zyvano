/**
 * Project asset library.
 *
 * Uploads stream to the API with real progress; every listed asset is fetched
 * through the authorized content endpoint rather than a raw storage URL, so a
 * leaked link cannot expose another tenant's media.
 */
import { useRef, useState, type DragEvent } from 'react';

import type { AssetDTO, AssetKind, ProjectDTO } from '@zyvano/shared';

import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  Progress,
  formatBytes,
  relativeTime,
  useToast,
} from '../ui';
import { assetsApi } from '../../lib/api';
import { ApiError } from '../../lib/api-client';
import { useAsync } from '../../hooks/use-async';
import { useAuth, usePermissions } from '../../state/auth-context';

const ACCEPTED = 'image/*,video/*,audio/*';
const MAX_BYTES = 500 * 1024 * 1024;

export function AssetsPanel({ project }: { project: ProjectDTO }) {
  const { push } = useToast();
  const { canUpload, canDelete } = usePermissions();
  const { activeOrganization } = useAuth();

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState<{ name: string; percent: number }[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<AssetDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [kindFilter, setKindFilter] = useState<AssetKind | 'all'>('all');

  const assets = useAsync(
    () => assetsApi.list({ projectId: project.id, perPage: 48 }),
    [project.id],
  );

  const items = (assets.data?.items ?? []).filter(
    (asset) => kindFilter === 'all' || asset.kind === kindFilter,
  );

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    for (const file of list) {
      if (file.size > MAX_BYTES) {
        push('error', `“${file.name}” is larger than the 500 MB limit.`);
        continue;
      }
      setUploads((current) => [...current, { name: file.name, percent: 0 }]);
      try {
        await assetsApi.upload({
          file,
          projectId: project.id,
          organizationId: activeOrganization?.id ?? null,
          onProgress: (percent) => {
            setUploads((current) =>
              current.map((entry) => (entry.name === file.name ? { ...entry, percent } : entry)),
            );
          },
        });
        push('success', `“${file.name}” uploaded.`);
      } catch (caught) {
        push(
          'error',
          caught instanceof ApiError
            ? caught.message
            : `“${file.name}” could not be uploaded.`,
        );
      } finally {
        setUploads((current) => current.filter((entry) => entry.name !== file.name));
      }
    }
    await assets.reload();
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    if (!canUpload) return;
    if (event.dataTransfer.files.length > 0) void uploadFiles(event.dataTransfer.files);
  }

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
    <div className="stack stack-4">
      <div className="row row-between row-wrap">
        <div className="row row-2 row-wrap">
          {(['all', 'image', 'video', 'audio', 'document'] as const).map((kind) => (
            <Button
              key={kind}
              size="sm"
              variant={kindFilter === kind ? 'primary' : 'ghost'}
              onClick={() => setKindFilter(kind)}
            >
              {kind === 'all' ? 'All' : kind.charAt(0).toUpperCase() + kind.slice(1)}
            </Button>
          ))}
        </div>
        <span className="text-xs faint">{items.length} shown</span>
      </div>

      {canUpload ? (
        <div
          className={`dropzone${dragOver ? ' dropzone--over' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
          }}
          role="button"
          tabIndex={0}
          aria-label="Upload media into this project"
        >
          <strong>Drop files here or click to upload</strong>
          <span className="text-xs">Images, video and audio · up to 500 MB per file</span>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED}
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) void uploadFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </div>
      ) : (
        <Alert tone="info">Your role does not allow uploading into this workspace.</Alert>
      )}

      {uploads.length > 0 ? (
        <div className="card">
          <div className="card-body card-body--tight stack stack-3">
            {uploads.map((entry) => (
              <div key={entry.name} className="stack stack-2">
                <div className="row row-between">
                  <span className="text-sm truncate">{entry.name}</span>
                  <span className="text-xs faint">{entry.percent}%</span>
                </div>
                <Progress value={entry.percent} />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {assets.error ? <Alert tone="danger">Assets could not be loaded: {assets.error.message}</Alert> : null}

      {assets.initialLoading ? (
        <div className="card">
          <LoadingState label="Loading assets…" />
        </div>
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="▤"
            title="No assets"
            description="Uploaded media and generated stills, clips and voice tracks all live here. Generated assets appear automatically when a render completes."
          />
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
          {items.map((asset) => (
            <AssetTile
              key={asset.id}
              asset={asset}
              organizationId={activeOrganization?.id ?? null}
              canDelete={canDelete}
              onDelete={() => setConfirmDelete(asset)}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this asset?"
        message="The file is removed from storage and any reference to it is cleared. Generations that produced it keep their history."
        confirmLabel="Delete asset"
        busy={deleting}
        onConfirm={() => (confirmDelete ? deleteAsset(confirmDelete) : undefined)}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

function AssetTile({
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
        ) : asset.kind === 'audio' ? (
          <span aria-hidden="true" style={{ fontSize: 28, opacity: 0.5 }}>
            ♪
          </span>
        ) : (
          <span aria-hidden="true" style={{ fontSize: 28, opacity: 0.5 }}>
            ▢
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
