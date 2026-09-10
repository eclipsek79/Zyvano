/**
 * Project workspace.
 *
 * The central creative surface: the brief, the script, the storyboard, the scene
 * list, the asset library and the export queue for one project.
 *
 * Two rules shape this screen:
 *  1. Every asynchronous action is confirmed by the server before the UI claims it
 *     happened. Queuing returns 202 and a generation row; the row's own status is
 *     what the operator sees, polled while work is in flight.
 *  2. The workspace is fully recoverable. All state lives on the server, so a
 *     refresh mid-render rebuilds the screen from the same data.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import type { ProjectDTO } from '@zyvano/shared';
import { ASPECT_RATIOS } from '@zyvano/shared';

import { PageHeader } from '../components/app-layout';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  Modal,
  Progress,
  SelectField,
  StatusBadge,
  Tabs,
  TextAreaField,
  TextField,
  formatDuration,
  relativeTime,
  useToast,
} from '../components/ui';
import { ScenesPanel } from '../components/workspace/scenes-panel';
import { ScriptPanel } from '../components/workspace/script-panel';
import { StoryboardPanel } from '../components/workspace/storyboard-panel';
import { AssetsPanel } from '../components/workspace/assets-panel';
import { ExportsPanel } from '../components/workspace/exports-panel';
import { generationsApi, projectsApi } from '../lib/api';
import { ApiError } from '../lib/api-client';
import { useAsync, useLiveActivity, usePolling } from '../hooks/use-async';
import { usePermissions } from '../state/auth-context';

type TabId = 'overview' | 'script' | 'storyboard' | 'scenes' | 'assets' | 'exports';

export function ProjectWorkspacePage() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const { push } = useToast();
  const { canEdit, canManageProjects } = usePermissions();

  const [tab, setTab] = useState<TabId>('overview');
  const [editingBrief, setEditingBrief] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);

  const project = useAsync<ProjectDTO>(() => projectsApi.get(projectId), [projectId]);
  const generations = useAsync(
    () => generationsApi.list({ projectId, perPage: 20, sort: 'createdAt', order: 'desc' }),
    [projectId],
  );

  const items = generations.data?.items ?? [];
  const live = useLiveActivity(items);
  // Polls the project-scoped generation feed while any row is non-terminal.
  const { data: polled } = usePolling(
    () => generationsApi.list({ projectId, perPage: 20, sort: 'createdAt', order: 'desc' }),
    live,
    2500,
  );

  const generationList = polled?.items ?? items;
  const activeGenerations = useMemo(
    () => generationList.filter((item) => item.status === 'queued' || item.status === 'processing'),
    [generationList],
  );

  // A finished generation invalidates the derived surfaces: a script appears, a
  // storyboard creates scenes, a scene render adds a preview. Refreshing on
  // completion keeps every panel consistent without polling them all.
  const completedSignature = useMemo(
    () =>
      generationList
        .filter((item) => item.status === 'completed')
        .map((item) => item.id)
        .join(','),
    [generationList],
  );

  const [lastSignature, setLastSignature] = useState('');
  useEffect(() => {
    if (!completedSignature) return;
    if (lastSignature && completedSignature !== lastSignature) {
      void project.reload();
    }
    setLastSignature(completedSignature);
  }, [completedSignature, lastSignature, project]);

  async function handleDuplicate() {
    setDuplicating(true);
    try {
      const copy = await projectsApi.duplicate(projectId, { includeAssets: false });
      push('success', `Duplicated as “${copy.name}”.`);
      navigate(`/projects/${copy.id}`);
    } catch (caught) {
      push('error', caught instanceof ApiError ? caught.message : 'Duplication failed.');
    } finally {
      setDuplicating(false);
    }
  }

  async function handleArchive() {
    try {
      await projectsApi.archive(projectId);
      push('success', 'Project archived.');
      await project.reload();
    } catch (caught) {
      push('error', caught instanceof ApiError ? caught.message : 'Archive failed.');
    }
  }

  async function handleDelete() {
    if (!project.data) return;
    setDeleting(true);
    try {
      // The API requires the exact project name as confirmation so a stray or
      // replayed request cannot destroy the project.
      await projectsApi.remove(projectId, project.data.name);
      push('success', 'Project deleted.');
      navigate('/', { replace: true });
    } catch (caught) {
      push('error', caught instanceof ApiError ? caught.message : 'Deletion failed.');
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (project.initialLoading) {
    return (
      <div className="card">
        <LoadingState label="Opening project…" />
      </div>
    );
  }

  if (project.error || !project.data) {
    const notFound = project.error instanceof ApiError && project.error.status === 404;
    return (
      <div className="card">
        <EmptyState
          icon="⚠"
          title={notFound ? 'Project not found' : 'Project could not be loaded'}
          description={
            notFound
              ? 'It may have been deleted, or it belongs to a workspace you are not a member of.'
              : (project.error?.message ?? 'Unknown error.')
          }
          action={
            <Link to="/" className="btn btn--primary">
              Back to dashboard
            </Link>
          }
        />
      </div>
    );
  }

  const current = project.data;

  return (
    <div className="stack stack-5">
      <PageHeader
        title={current.name}
        subtitle={`${current.organizationId} · ${current.aspectRatio}${
          current.targetDurationSeconds ? ` · ${formatDuration(current.targetDurationSeconds)}` : ''
        } · updated ${relativeTime(current.updatedAt)}`}
        actions={
          <>
            <StatusBadge status={current.status} />
            <Button size="sm" onClick={() => setEditingBrief(true)} disabled={!canEdit}>
              Edit brief
            </Button>
            <Button size="sm" onClick={handleDuplicate} loading={duplicating} disabled={!canManageProjects}>
              Duplicate
            </Button>
            <Button size="sm" onClick={handleArchive} disabled={!canEdit || current.status === 'archived'}>
              Archive
            </Button>
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)} disabled={!canEdit}>
              Delete
            </Button>
          </>
        }
      />

      {activeGenerations.length > 0 ? (
        <section className="card">
          <div className="card-header">
            <h2 className="grow">Worker activity</h2>
            <Badge tone="accent" live>
              {activeGenerations.length} running
            </Badge>
          </div>
          <div className="card-body stack stack-3">
            {activeGenerations.map((generation) => (
              <div key={generation.id} className="stack stack-2">
                <div className="row row-between row-wrap">
                  <span className="text-sm" style={{ textTransform: 'capitalize' }}>
                    {generation.kind}
                    <span className="muted">
                      {' '}
                      · {generation.provider ?? 'default provider'}
                    </span>
                  </span>
                  <span className="row row-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await generationsApi.cancel(generation.id);
                          push('success', 'Cancellation requested.');
                          await generations.reload();
                        } catch (caught) {
                          push('error', caught instanceof ApiError ? caught.message : 'Cancel failed.');
                        }
                      }}
                    >
                      Cancel
                    </Button>
                    <span className="text-xs faint">{generation.progress}%</span>
                  </span>
                </div>
                <Progress value={generation.progress} />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <Tabs<TabId>
        tabs={[
          { id: 'overview', label: 'Brief & pipeline' },
          { id: 'script', label: 'Script' },
          { id: 'storyboard', label: 'Storyboard' },
          { id: 'scenes', label: 'Scenes' },
          { id: 'assets', label: 'Assets' },
          { id: 'exports', label: 'Exports' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' ? (
        <OverviewPanel
          project={current}
          generations={generationList}
          onRefresh={() => {
            void project.reload();
            void generations.reload();
          }}
        />
      ) : null}

      {tab === 'script' ? (
        <ScriptPanel
          project={current}
          generations={generationList}
          onChanged={() => {
            void project.reload();
            void generations.reload();
          }}
        />
      ) : null}

      {tab === 'storyboard' ? (
        <StoryboardPanel
          project={current}
          generations={generationList}
          onChanged={() => {
            void project.reload();
            void generations.reload();
          }}
        />
      ) : null}

      {tab === 'scenes' ? (
        <ScenesPanel
          project={current}
          generations={generationList}
          onChanged={() => {
            void project.reload();
            void generations.reload();
          }}
        />
      ) : null}

      {tab === 'assets' ? <AssetsPanel project={current} /> : null}

      {tab === 'exports' ? <ExportsPanel project={current} /> : null}

      <EditBriefModal
        open={editingBrief}
        project={current}
        onClose={() => setEditingBrief(false)}
        onSaved={(updated) => {
          setEditingBrief(false);
          project.setData(updated);
          push('success', 'Brief updated.');
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this project?"
        message="The project, its scenes, generations and assets are removed. Stored media is queued for deletion from object storage. This cannot be undone."
        confirmLabel="Delete project"
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

/* ------------------------------- overview --------------------------------- */

function OverviewPanel({
  project,
  generations,
  onRefresh,
}: {
  project: ProjectDTO;
  generations: { id: string; kind: string; status: string; createdAt: string; errorMessage: string | null }[];
  onRefresh: () => void;
}) {
  const { push } = useToast();
  const { canGenerate } = usePermissions();

  const failed = generations.filter((generation) => generation.status === 'failed');

  return (
    <div className="grid grid--two">
      <section className="card">
        <div className="card-header">
          <h2 className="grow">Creative brief</h2>
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            Refresh
          </Button>
        </div>
        <div className="card-body stack stack-3">
          {project.prompt ? (
            <p style={{ whiteSpace: 'pre-wrap' }}>{project.prompt}</p>
          ) : (
            <EmptyState
              icon="✎"
              title="No brief yet"
              description="Add a creative brief describing the video you want. It drives script and storyboard generation."
            />
          )}
          {project.description ? (
            <>
              <hr className="divider" />
              <p className="muted text-sm" style={{ whiteSpace: 'pre-wrap' }}>
                {project.description}
              </p>
            </>
          ) : null}
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="grow">Pipeline</h2>
        </div>
        <div className="card-body stack stack-4">
          <ol className="pipeline-list">
            {[
              'Brief written',
              'Script generated or authored',
              'Storyboard planned',
              'Scenes rendered',
              'Export rendered and verified',
            ].map((step, index) => (
              <li className="pipeline-step" key={step}>
                <span className="pipeline-index">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>

          {!project.prompt ? (
            <Alert tone="warning">
              Add a brief before generating a script. The provider needs the creative direction to
              work from.
            </Alert>
          ) : null}

          {failed.length > 0 ? (
            <Alert tone="danger">
              {failed.length} generation{failed.length === 1 ? '' : 's'} failed. Open the scene or
              generation to see the provider's reason and retry. Providers must be configured on
              this deployment for generation to run.
            </Alert>
          ) : null}

          <div className="stack stack-2">
            <span className="text-xs faint">Recent generations</span>
            {generations.length === 0 ? (
              <p className="muted text-sm">Nothing has been generated for this project yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Status</th>
                    <th className="text-right">When</th>
                  </tr>
                </thead>
                <tbody>
                  {generations.slice(0, 6).map((generation) => (
                    <tr key={generation.id}>
                      <td style={{ textTransform: 'capitalize' }}>{generation.kind}</td>
                      <td>
                        <StatusBadge status={generation.status} />
                      </td>
                      <td className="text-right text-xs faint">{relativeTime(generation.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {canGenerate ? (
            <p className="text-xs faint">
              Use the Script and Storyboard tabs to queue generation. Progress shown there is
              reported by the workers, not simulated.
            </p>
          ) : (
            <Alert tone="info">
              Your role in this workspace is read-only for generation.
              <button
                type="button"
                className="btn btn--sm"
                style={{ marginLeft: 8 }}
                onClick={() => push('info', 'Ask a workspace admin to raise your role.')}
              >
                Why?
              </button>
            </Alert>
          )}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------ edit brief -------------------------------- */

function EditBriefModal({
  open,
  project,
  onClose,
  onSaved,
}: {
  open: boolean;
  project: ProjectDTO;
  onClose: () => void;
  onSaved: (project: ProjectDTO) => void;
}) {
  const [name, setName] = useState(project.name);
  const [prompt, setPrompt] = useState(project.prompt ?? '');
  const [aspectRatio, setAspectRatio] = useState(project.aspectRatio);
  const [duration, setDuration] = useState(
    project.targetDurationSeconds ? String(project.targetDurationSeconds) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Re-sync when the underlying project changes (a refresh brought new values).
  useEffect(() => {
    setName(project.name);
    setPrompt(project.prompt ?? '');
    setAspectRatio(project.aspectRatio);
    setDuration(project.targetDurationSeconds ? String(project.targetDurationSeconds) : '');
  }, [project]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    const parsedDuration = duration.trim() ? Number.parseInt(duration, 10) : null;
    if (parsedDuration !== null && (!Number.isFinite(parsedDuration) || parsedDuration <= 0)) {
      setFieldErrors({ targetDurationSeconds: 'Enter a positive number of seconds.' });
      return;
    }

    setSaving(true);
    try {
      const updated = await projectsApi.update(project.id, {
        name: name.trim(),
        prompt: prompt.trim() ? prompt.trim() : null,
        aspectRatio: aspectRatio as (typeof ASPECT_RATIOS)[number],
        targetDurationSeconds: parsedDuration,
      });
      onSaved(updated);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        setError(caught.message);
      } else {
        setError('The project could not be saved. Please retry.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Edit project"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={(e) => handleSubmit(e as unknown as FormEvent)}>
            Save changes
          </Button>
        </>
      }
    >
      <form className="stack stack-4" onSubmit={handleSubmit} noValidate>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <TextField
          label="Project name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          {...(fieldErrors.name ? { error: fieldErrors.name } : {})}
        />
        <TextAreaField
          label="Creative brief"
          className="textarea--tall"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          hint="Describe subject, mood, setting and pacing. This is the prompt used for generation."
          {...(fieldErrors.prompt ? { error: fieldErrors.prompt } : {})}
        />
        <div className="grid grid--two">
          <SelectField
            label="Aspect ratio"
            value={aspectRatio}
            onChange={(event) => setAspectRatio(event.target.value)}
            options={ASPECT_RATIOS.map((ratio) => ({ value: ratio, label: ratio }))}
          />
          <TextField
            label="Target length (seconds)"
            type="number"
            min={1}
            max={3600}
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
            {...(fieldErrors.targetDurationSeconds ? { error: fieldErrors.targetDurationSeconds } : {})}
          />
        </div>
      </form>
    </Modal>
  );
}
