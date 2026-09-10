/**
 * Studio dashboard.
 *
 * Shows the real workspace state: the projects that exist, the generations and
 * exports currently in flight, and the credit usage the server reports for the
 * period. There are no invented numbers — every figure comes from an endpoint.
 */
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ASPECT_RATIOS } from '@zyvano/shared';
import type { ProjectDTO } from '@zyvano/shared';

import { PageHeader } from '../components/app-layout';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  LoadingState,
  Modal,
  Progress,
  SelectField,
  StatusBadge,
  TextAreaField,
  TextField,
  formatDuration,
  relativeTime,
  useToast,
} from '../components/ui';
import { generationsApi, exportsApi, projectsApi, usageApi } from '../lib/api';
import { ApiError } from '../lib/api-client';
import { useAsync, useLiveActivity, usePolling } from '../hooks/use-async';
import { useAuth, usePermissions } from '../state/auth-context';

export function DashboardPage() {
  const { activeOrganization } = useAuth();
  const { canManageProjects } = usePermissions();
  const navigate = useNavigate();

  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const projects = useAsync(
    () => projectsApi.list({ perPage: 24, sort: 'updatedAt', order: 'desc' }),
    [activeOrganization?.id],
  );

  const usage = useAsync(() => usageApi.summary(30), [activeOrganization?.id]);

  const generations = useAsync(
    () => generationsApi.list({ perPage: 8, sort: 'createdAt', order: 'desc' }),
    [activeOrganization?.id],
  );

  const exportsFeed = useAsync(
    () => exportsApi.list({ perPage: 5, sort: 'createdAt', order: 'desc' }),
    [activeOrganization?.id],
  );

  const generationItems = generations.data?.items ?? [];
  const exportItems = exportsFeed.data?.items ?? [];

  // Poll only while there is genuine in-flight work, so an idle dashboard is silent.
  const generationsLive = useLiveActivity(generationItems);
  const exportsLive = useLiveActivity(exportItems);
  const { data: liveGenerations } = usePolling(
    () => generationsApi.list({ perPage: 8, sort: 'createdAt', order: 'desc' }),
    generationsLive,
    3000,
  );
  const { data: liveExports } = usePolling(
    () => exportsApi.list({ perPage: 5, sort: 'createdAt', order: 'desc' }),
    exportsLive,
    4000,
  );

  async function reloadAll() {
    setRefreshing(true);
    await Promise.all([
      projects.reload(),
      usage.reload(),
      generations.reload(),
      exportsFeed.reload(),
    ]);
    setRefreshing(false);
  }

  const projectList = projects.data?.items ?? [];
  const summary = usage.data;
  const shownGenerations = liveGenerations?.items ?? generationItems;
  const shownExports = liveExports?.items ?? exportItems;
  const activeWork = shownGenerations.filter((item) =>
    ['queued', 'processing'].includes(item.status),
  );

  return (
    <div className="stack stack-5">
      <PageHeader
        title="Studio"
        subtitle={
          activeOrganization
            ? `${activeOrganization.name} · ${activeOrganization.role ?? 'member'}`
            : 'Your Zyvano workspace'
        }
        actions={
          <>
            <Button onClick={reloadAll} loading={refreshing}>
              Refresh
            </Button>
            <Button
              variant="primary"
              disabled={!canManageProjects}
              onClick={() => setCreating(true)}
            >
              New project
            </Button>
          </>
        }
      />

      {projects.error ? (
        <Alert tone="danger">
          Projects could not be loaded: {projects.error.message}
        </Alert>
      ) : null}

      {/* Usage overview: every number is server-reported for the selected period. */}
      <section className="grid grid--stats">
        <div className="stat">
          <div className="stat-label">Credits used · 30d</div>
          <div className="stat-value">{summary ? summary.creditsUsed : '—'}</div>
          <div className="stat-sub">
            {summary ? `${summary.creditsRemaining} of ${summary.quota} remaining` : 'Loading usage…'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Projects</div>
          <div className="stat-value">{projects.initialLoading ? '—' : projectList.length}</div>
          <div className="stat-sub">In this workspace</div>
        </div>
        <div className="stat">
          <div className="stat-label">In flight</div>
          <div className="stat-value">{activeWork.length}</div>
          <div className="stat-sub">Generations queued or rendering</div>
        </div>
        <div className="stat">
          <div className="stat-label">Latest export</div>
          <div className="stat-value">
            {shownExports[0] ? (
              <StatusBadge status={shownExports[0].status} />
            ) : (
              <span className="muted" style={{ fontSize: 16 }}>
                None yet
              </span>
            )}
          </div>
          <div className="stat-sub">
            {shownExports[0] ? relativeTime(shownExports[0].createdAt) : 'Render a project to export'}
          </div>
        </div>
      </section>

      {/* Live work indicator: appears only when the server says work is running. */}
      {activeWork.length > 0 ? (
        <section className="card">
          <div className="card-header">
            <h2 className="grow">Running now</h2>
            <Badge tone="accent" live>
              {activeWork.length} active
            </Badge>
          </div>
          <div className="card-body stack stack-3">
            {activeWork.map((generation) => (
              <div key={generation.id} className="stack stack-2">
                <div className="row row-between row-wrap">
                  <span className="text-sm">
                    <strong style={{ textTransform: 'capitalize' }}>{generation.kind}</strong>{' '}
                    <span className="muted">
                      · {generation.provider ?? 'default provider'}
                      {generation.model ? ` / ${generation.model}` : ''}
                    </span>
                  </span>
                  <span className="row row-2">
                    <StatusBadge status={generation.status} />
                    <span className="text-xs faint">{generation.progress}%</span>
                  </span>
                </div>
                <Progress value={generation.progress} />
                <Link to={`/projects/${generation.projectId}`} className="text-xs">
                  Open project
                </Link>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Projects. */}
      <section className="stack stack-3">
        <div className="row row-between">
          <h2>Projects</h2>
          {projectList.length > 0 ? (
            <span className="text-xs faint">{projects.data?.meta.total ?? 0} total</span>
          ) : null}
        </div>

        {projects.initialLoading ? (
          <div className="card">
            <LoadingState label="Loading projects…" />
          </div>
        ) : projectList.length === 0 ? (
          <div className="card">
            <EmptyState
              icon="◧"
              title="No projects yet"
              description="A project holds the brief, script, storyboard, scenes and exports for one video. Create your first one to start the pipeline."
              action={
                <Button variant="primary" onClick={() => setCreating(true)} disabled={!canManageProjects}>
                  Create a project
                </Button>
              }
            />
          </div>
        ) : (
          <div className="grid grid--cards">
            {projectList.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </section>

      {/* Recent generations. */}
      <section className="grid grid--two">
        <div className="card">
          <div className="card-header">
            <h2 className="grow">Recent generations</h2>
          </div>
          {shownGenerations.length === 0 ? (
            <EmptyState
              icon="✦"
              title="No generations yet"
              description="Generated scripts, storyboards, images, video and voice all appear here with their real server status."
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Provider</th>
                  <th className="text-right">Credits</th>
                  <th className="text-right">When</th>
                </tr>
              </thead>
              <tbody>
                {shownGenerations.map((generation) => (
                  <tr key={generation.id}>
                    <td style={{ textTransform: 'capitalize' }}>{generation.kind}</td>
                    <td>
                      <StatusBadge status={generation.status} />
                    </td>
                    <td className="muted text-sm truncate">
                      {generation.provider ?? '—'}
                      {generation.model ? ` / ${generation.model}` : ''}
                    </td>
                    <td className="text-right mono">{generation.creditsUsed}</td>
                    <td className="text-right text-xs faint">
                      {relativeTime(generation.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="grow">Usage by capability</h2>
            <span className="text-xs faint">Last 30 days</span>
          </div>
          {!summary || Object.keys(summary.byCapability).length === 0 ? (
            <EmptyState
              icon="◔"
              title="No usage recorded"
              description="Usage is written when a provider call settles, so it always reflects billed work."
            />
          ) : (
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
                {Object.entries(summary.byCapability).map(([capability, stats]) => (
                  <tr key={capability}>
                    <td style={{ textTransform: 'capitalize' }}>{capability}</td>
                    <td className="text-right mono">{stats.requests}</td>
                    <td className="text-right mono">{stats.units}</td>
                    <td className="text-right mono">{stats.credits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <CreateProjectModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(project) => {
          setCreating(false);
          void projects.reload();
          navigate(`/projects/${project.id}`);
        }}
      />
    </div>
  );
}

/* ------------------------------ project card ------------------------------ */

function ProjectCard({ project }: { project: ProjectDTO }) {
  const counts = project.counts;
  return (
    <Link to={`/projects/${project.id}`} className="project-card">
      <div className="project-thumb">
        {project.thumbnailUrl ? (
          <img src={project.thumbnailUrl} alt="" loading="lazy" />
        ) : (
          <span className="project-thumb-icon" aria-hidden="true">
            ▶
          </span>
        )}
        <span className="project-thumb-status">
          <StatusBadge status={project.status} />
        </span>
      </div>
      <div className="project-card-body">
        <span className="project-card-title" title={project.name}>
          {project.name}
        </span>
        <span className="project-card-desc">
          {project.prompt ?? project.description ?? 'No brief yet.'}
        </span>
        <div className="project-card-meta">
          <span>{project.aspectRatio}</span>
          <span>{project.targetDurationSeconds ? formatDuration(project.targetDurationSeconds) : '—'}</span>
          {counts ? <span>{counts.scenes} scenes</span> : null}
          <span className="grow text-right">{relativeTime(project.updatedAt)}</span>
        </div>
      </div>
    </Link>
  );
}

/* --------------------------- create project modal ------------------------- */

export function CreateProjectModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (project: ProjectDTO) => void;
}) {
  const { push } = useToast();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState<string>('16:9');
  const [duration, setDuration] = useState('30');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    if (!name.trim()) {
      setFieldErrors({ name: 'Give the project a name.' });
      return;
    }

    setSubmitting(true);
    try {
      const parsedDuration = Number.parseInt(duration, 10);
      const project = await projectsApi.create({
        name: name.trim(),
        prompt: prompt.trim() ? prompt.trim() : null,
        aspectRatio: aspectRatio as (typeof ASPECT_RATIOS)[number],
        targetDurationSeconds:
          Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : null,
      });
      push('success', `Project “${project.name}” created.`);
      onCreated(project);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        setError(caught.message);
      } else {
        setError('The project could not be created. Please retry.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="New project"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={submitting}
            onClick={(event) => handleSubmit(event as unknown as FormEvent)}
          >
            Create project
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
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="A 30-second launch film for a solar-powered backpack. Golden-hour hiking footage, a calm narrator, product close-ups."
          hint="This becomes the prompt that drives script and storyboard generation."
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
          />
        </div>
      </form>
    </Modal>
  );
}
