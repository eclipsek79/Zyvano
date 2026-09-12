/**
 * Scene list and per-scene render controls.
 *
 * Scenes are the unit of AI generation: each one carries its own prompt and can be
 * rendered as a still or a clip. Queuing returns a generation row; this panel
 * tracks the rows it started and reports the worker's own progress.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import type { AssetDTO, GenerationDTO, ProjectDTO, SceneDTO } from '@zyvano/shared';

import {
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  Modal,
  Progress,
  StatusBadge,
  TextAreaField,
  TextField,
  formatDuration,
  relativeTime,
  useToast,
} from '../ui';
import { assetsApi, generationsApi, scenesApi } from '../../lib/api';
import { ApiError } from '../../lib/api-client';
import { useAsync, isTerminalStatus, useLiveActivity, usePolling } from '../../hooks/use-async';
import { useAuth, usePermissions } from '../../state/auth-context';
import { describeGenerationError } from './script-panel';

type SceneStatus = SceneDTO['status'];

/** The status a scene shows: the live generation's state when one is running. */
function sceneStatusFrom(
  scene: SceneDTO,
  tracked: GenerationDTO | undefined,
): SceneStatus {
  if (tracked && (tracked.status === 'queued' || tracked.status === 'processing')) {
    return tracked.status;
  }
  return scene.status;
}

export function ScenesPanel({
  project,
  generations,
  onChanged,
}: {
  project: ProjectDTO;
  generations: GenerationDTO[];
  onChanged: () => void;
}) {
  const { push } = useToast();
  const { canEdit, canGenerate } = usePermissions();
  const { activeOrganization } = useAuth();

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SceneDTO | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SceneDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busySceneId, setBusySceneId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

  const scenes = useAsync(() => scenesApi.list(project.id), [project.id]);

  const sceneList = scenes.data ?? [];

  // Group generation rows by scene so each card can show its own live work.
  const byScene = useMemo(() => {
    const map = new Map<string, GenerationDTO[]>();
    for (const generation of generations) {
      if (!generation.sceneId) continue;
      const list = map.get(generation.sceneId) ?? [];
      list.push(generation);
      map.set(generation.sceneId, list);
    }
    return map;
  }, [generations]);

  // Track the generation rows this panel started.
  const [tracked, setTracked] = useState<Record<string, string>>({});
  const liveGenerations = useMemo(
    () => generations.filter((g) => g.status === 'queued' || g.status === 'processing'),
    [generations],
  );
  const anyLive = useLiveActivity(liveGenerations);

  const { data: polledGenerations } = usePolling(
    () => generationsApi.list({ projectId: project.id, perPage: 60, sort: 'createdAt', order: 'desc' }),
    anyLive,
    2500,
  );

  useEffect(() => {
    if (!polledGenerations) return;
    // A settled generation can change a scene's preview, so reload the scene list
    // whenever a tracked row reaches a terminal state.
    const settled = polledGenerations.items.some(
      (item) =>
        tracked[item.sceneId ?? ''] === item.id && item.status !== 'queued' && item.status !== 'processing',
    );
    if (settled) {
      void scenes.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polledGenerations]);

  /**
   * Whether a render this panel started has finished, according to the parent's feed.
   *
   * This deliberately reads the `generations` prop rather than this panel's own poll.
   * Both pollers observe the same transition within a tick, and the moment it is seen
   * the parent's `usePolling` stops driving the panel — so a reload triggered only by
   * the panel's own poll could be missed entirely, leaving a finished render displayed
   * as permanently "queued". The prop is the authoritative copy, so keying off it
   * makes the refresh deterministic.
   */
  const settledFromFeed = useMemo(
    () =>
      generations.some(
        (item) =>
          item.sceneId !== null &&
          tracked[item.sceneId] === item.id &&
          isTerminalStatus(item.status),
      ),
    [generations, tracked],
  );

  useEffect(() => {
    if (!settledFromFeed) return;
    void scenes.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledFromFeed]);

  async function queueScene(scene: SceneDTO, kind: 'image' | 'video') {
    if (!scene.prompt?.trim() && !scene.description?.trim()) {
      push('error', 'Give the scene a prompt before rendering it.');
      return;
    }
    setBusySceneId(scene.id);
    try {
      const result = await generationsApi.generateScene({
        sceneId: scene.id,
        kind,
        ...(scene.prompt ? { prompt: scene.prompt } : {}),
        durationSeconds: Math.max(1, Math.round(scene.durationSeconds)),
        idempotencyKey: `${kind}-${scene.id}-${Date.now()}`,
      });
      setTracked((current) => ({ ...current, [scene.id]: result.generation.id }));
      push('success', `${kind === 'video' ? 'Clip' : 'Still'} render queued.`);
      onChanged();
    } catch (caught) {
      push('error', describeGenerationError(caught));
    } finally {
      setBusySceneId(null);
    }
  }

  async function move(scene: SceneDTO, direction: -1 | 1) {
    const index = sceneList.findIndex((item) => item.id === scene.id);
    const target = index + direction;
    if (target < 0 || target >= sceneList.length) return;

    const next = [...sceneList];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);

    setReordering(true);
    try {
      const updated = await scenesApi.reorder(
        project.id,
        next.map((item) => item.id),
      );
      scenes.setData(updated);
    } catch (caught) {
      push('error', caught instanceof ApiError ? caught.message : 'Reorder failed.');
      await scenes.reload();
    } finally {
      setReordering(false);
    }
  }

  async function deleteScene(scene: SceneDTO) {
    setDeleting(true);
    try {
      await scenesApi.remove(project.id, scene.id);
      push('success', 'Scene deleted.');
      setConfirmDelete(null);
      await scenes.reload();
      onChanged();
    } catch (caught) {
      push('error', caught instanceof ApiError ? caught.message : 'Delete failed.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="stack stack-4">
      <div className="row row-between row-wrap">
        <span className="text-sm muted">
          {sceneList.length} scene{sceneList.length === 1 ? '' : 's'} ·{' '}
          {formatDuration(sceneList.reduce((total, scene) => total + scene.durationSeconds, 0))} total
        </span>
        <div className="row row-2">
          <Button size="sm" onClick={() => void scenes.reload()}>
            Refresh
          </Button>
          <Button size="sm" variant="primary" onClick={() => setAdding(true)} disabled={!canEdit}>
            Add scene
          </Button>
        </div>
      </div>

      {scenes.error ? <Alert tone="danger">Scenes could not be loaded: {scenes.error.message}</Alert> : null}

      {scenes.initialLoading ? (
        <div className="card">
          <LoadingState label="Loading scenes…" />
        </div>
      ) : sceneList.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="▦"
            title="No scenes yet"
            description="Scenes are what get rendered. Generate a storyboard to create them from your script, or add one by hand."
            action={
              <Button variant="primary" onClick={() => setAdding(true)} disabled={!canEdit}>
                Add the first scene
              </Button>
            }
          />
        </div>
      ) : (
        <div className="stack stack-3">
          {sceneList.map((scene, index) => {
            const sceneGenerations = byScene.get(scene.id) ?? [];
            const trackedIdForScene = tracked[scene.id];
            const active =
              sceneGenerations.find(
                (g) => g.id === trackedIdForScene && (g.status === 'queued' || g.status === 'processing'),
              ) ?? sceneGenerations.find((g) => g.status === 'queued' || g.status === 'processing');
            const latest = active ?? sceneGenerations[0];
            const failed = sceneGenerations.find((g) => g.status === 'failed');
            const status = sceneStatusFrom(scene, active);

            return (
              <article key={scene.id} className={`scene-item${active ? ' scene-item--active' : ''}`}>
                <div className="scene-preview">
                  {scene.previewAssetId && !active ? (
                    <ScenePreview assetId={scene.previewAssetId} organizationId={activeOrganization?.id ?? null} />
                  ) : active ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : (
                    <span className="faint text-xs">No preview</span>
                  )}
                </div>

                <div className="grow stack stack-2">
                  <div className="row row-between row-wrap">
                    <span className="row row-2">
                      <span className="scene-index">{index + 1}</span>
                      <strong>{scene.title}</strong>
                      <StatusBadge status={status} />
                    </span>
                    <span className="text-xs faint">{formatDuration(scene.durationSeconds)}</span>
                  </div>

                  <p className="text-sm muted" style={{ whiteSpace: 'pre-wrap' }}>
                    {scene.prompt ?? scene.description ?? 'No prompt set.'}
                  </p>

                  {active ? (
                    <div className="stack stack-2">
                      <Progress value={active.progress} />
                      <span className="text-xs faint">
                        {active.kind} · {active.provider ?? 'default provider'} · {active.progress}%
                      </span>
                    </div>
                  ) : null}

                  {failed && !active ? (
                    <Alert
                      tone="danger"
                      action={
                        <Button
                          size="sm"
                          onClick={async () => {
                            try {
                              await generationsApi.retry(failed.id);
                              setTracked((current) => ({ ...current, [scene.id]: failed.id }));
                              push('success', 'Retry queued.');
                            } catch (caught) {
                              push('error', describeGenerationError(caught));
                            }
                          }}
                        >
                          Retry
                        </Button>
                      }
                    >
                      {failed.errorMessage ?? 'The last render failed.'}
                    </Alert>
                  ) : null}

                  <div className="row row-2 row-wrap">
                    <Button
                      size="sm"
                      onClick={() => queueScene(scene, 'image')}
                      loading={busySceneId === scene.id}
                      disabled={!canGenerate || Boolean(active)}
                    >
                      Render still
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => queueScene(scene, 'video')}
                      loading={busySceneId === scene.id}
                      disabled={!canGenerate || Boolean(active)}
                    >
                      Render clip
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(scene)} disabled={!canEdit}>
                      Edit
                    </Button>
                    <div className="grow" />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => move(scene, -1)}
                      disabled={!canEdit || index === 0 || reordering}
                      aria-label={`Move “${scene.title}” earlier`}
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => move(scene, 1)}
                      disabled={!canEdit || index === sceneList.length - 1 || reordering}
                      aria-label={`Move “${scene.title}” later`}
                    >
                      ↓
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setConfirmDelete(scene)}
                      disabled={!canEdit}
                    >
                      Delete
                    </Button>
                  </div>

                  {latest && !active ? (
                    <span className="text-xs faint">
                      Last render {relativeTime(latest.finishedAt ?? latest.createdAt)} ·{' '}
                      {latest.creditsUsed} credits
                    </span>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <SceneEditorModal
        open={adding || editing !== null}
        projectId={project.id}
        scene={editing}
        nextIndex={sceneList.length}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
        onSaved={async (message) => {
          setAdding(false);
          setEditing(null);
          push('success', message);
          await scenes.reload();
          onChanged();
        }}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this scene?"
        message="The scene is removed from the project timeline. Rendered media it produced is deleted along with it."
        confirmLabel="Delete scene"
        busy={deleting}
        onConfirm={() => (confirmDelete ? deleteScene(confirmDelete) : undefined)}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

/** Streams a scene preview through the authorized content endpoint. */
function ScenePreview({
  assetId,
  organizationId,
}: {
  assetId: string;
  organizationId: string | null;
}) {
  const asset = useAsync<AssetDTO>(() => assetsApi.get(assetId), [assetId]);

  if (asset.initialLoading) return <span className="spinner" aria-hidden="true" />;
  if (!asset.data) return <span className="faint text-xs">Unavailable</span>;

  const url = assetsApi.contentUrl(assetId, organizationId);

  return asset.data.kind === 'video' ? (
    <video src={url} muted playsInline preload="metadata" />
  ) : (
    <img src={url} alt="" loading="lazy" />
  );
}

/* ---------------------------- create/edit modal --------------------------- */

function SceneEditorModal({
  open,
  projectId,
  scene,
  nextIndex,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  scene: SceneDTO | null;
  nextIndex: number;
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState('5');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(scene?.title ?? '');
    setPrompt(scene?.prompt ?? scene?.description ?? '');
    setDuration(scene ? String(scene.durationSeconds) : '5');
    setError(null);
    setFieldErrors({});
  }, [open, scene]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    if (!title.trim()) {
      setFieldErrors({ title: 'Give the scene a title.' });
      return;
    }
    const parsedDuration = Number.parseFloat(duration);
    if (!Number.isFinite(parsedDuration) || parsedDuration < 0.5 || parsedDuration > 600) {
      setFieldErrors({ durationSeconds: 'Duration must be between 0.5 and 600 seconds.' });
      return;
    }

    setSaving(true);
    try {
      if (scene) {
        await scenesApi.update(projectId, scene.id, {
          title: title.trim(),
          prompt: prompt.trim() ? prompt.trim() : null,
          description: prompt.trim() ? prompt.trim() : null,
          durationSeconds: parsedDuration,
        });
        await onSaved('Scene updated.');
      } else {
        await scenesApi.create(projectId, {
          title: title.trim(),
          prompt: prompt.trim() ? prompt.trim() : null,
          description: prompt.trim() ? prompt.trim() : null,
          durationSeconds: parsedDuration,
          orderIndex: nextIndex,
        });
        await onSaved('Scene added.');
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        setError(caught.message);
      } else {
        setError('The scene could not be saved. Please retry.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title={scene ? 'Edit scene' : 'Add scene'}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            onClick={(event) => handleSubmit(event as unknown as FormEvent)}
          >
            {scene ? 'Save scene' : 'Add scene'}
          </Button>
        </>
      }
    >
      <form className="stack stack-4" onSubmit={handleSubmit} noValidate>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <TextField
          label="Scene title"
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          {...(fieldErrors.title ? { error: fieldErrors.title } : {})}
        />
        <TextAreaField
          label="Render prompt"
          className="textarea--tall"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          hint="Describe exactly what should be in frame. This text goes to the image or video provider."
        />
        <TextField
          label="Duration (seconds)"
          type="number"
          step="0.5"
          min={0.5}
          max={600}
          value={duration}
          onChange={(event) => setDuration(event.target.value)}
          {...(fieldErrors.durationSeconds ? { error: fieldErrors.durationSeconds } : {})}
        />
      </form>
    </Modal>
  );
}
