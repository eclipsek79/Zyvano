/**
 * Storyboard workspace.
 *
 * A storyboard generation produces both the shot list and the scenes it implies,
 * so completing one refreshes the project. When a plan already exists the panel
 * shows each shot with the scene it created.
 */
import { useEffect, useMemo, useState } from 'react';

import type { GenerationDTO, ProjectDTO, StoryboardDTO } from '@zyvano/shared';

import {
  Alert,
  Badge,
  Button,
  EmptyState,
  LoadingState,
  Progress,
  StatusBadge,
  TextField,
  relativeTime,
  useToast,
} from '../ui';
import { generationsApi, scriptsApi } from '../../lib/api';
import { useAsync, usePolling } from '../../hooks/use-async';
import { usePermissions } from '../../state/auth-context';
import { describeGenerationError } from './script-panel';

export function StoryboardPanel({
  project,
  generations,
  onChanged,
}: {
  project: ProjectDTO;
  generations: GenerationDTO[];
  onChanged: () => void;
}) {
  const { push } = useToast();
  const { canGenerate } = usePermissions();

  const [sceneCount, setSceneCount] = useState('6');
  const [queuing, setQueuing] = useState(false);
  const [trackedId, setTrackedId] = useState<string | null>(null);

  const storyboards = useAsync(() => scriptsApi.storyboards(project.id), [project.id]);

  const boardGenerations = useMemo(
    () => generations.filter((generation) => generation.kind === 'storyboard'),
    [generations],
  );

  const activeGeneration = useMemo(() => {
    if (trackedId) {
      const tracked = boardGenerations.find((generation) => generation.id === trackedId);
      if (tracked) return tracked;
    }
    return boardGenerations.find((g) => g.status === 'queued' || g.status === 'processing') ?? null;
  }, [boardGenerations, trackedId]);

  const { data: polledGeneration } = usePolling(
    () => generationsApi.get(activeGeneration!.id),
    Boolean(activeGeneration),
    2000,
  );

  const live = polledGeneration ?? activeGeneration;

  useEffect(() => {
    if (!live) return;
    if (live.status === 'completed' || live.status === 'failed') {
      void storyboards.reload();
      onChanged();
      setTrackedId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.status, live?.id]);

  async function queueStoryboard() {
    const parsed = Number.parseInt(sceneCount, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 60) {
      push('error', 'Choose between 1 and 60 shots.');
      return;
    }
    setQueuing(true);
    try {
      const result = await scriptsApi.generateStoryboard(project.id, {
        sceneCount: parsed,
        idempotencyKey: `storyboard-${project.id}-${Date.now()}`,
      });
      setTrackedId(result.generation.id);
      push('success', 'Storyboard generation queued. Scenes are created when it completes.');
      onChanged();
    } catch (caught) {
      push('error', describeGenerationError(caught));
    } finally {
      setQueuing(false);
    }
  }

  const boards: StoryboardDTO[] = storyboards.data ?? [];
  const latest = boards[0];

  return (
    <div className="grid grid--two">
      <section className="card">
        <div className="card-header">
          <h2 className="grow">Plan a storyboard</h2>
          {live ? <StatusBadge status={live.status} /> : null}
        </div>
        <div className="card-body stack stack-4">
          <p className="muted text-sm">
            The planner reads the project's latest script and produces a shot list. Each shot becomes
            a scene you can render individually.
          </p>

          <TextField
            label="Number of shots"
            type="number"
            min={1}
            max={60}
            value={sceneCount}
            onChange={(event) => setSceneCount(event.target.value)}
            hint="Between 1 and 60. Each shot becomes one scene."
          />

          <Button
            variant="primary"
            onClick={queueStoryboard}
            loading={queuing}
            disabled={!canGenerate || Boolean(activeGeneration)}
          >
            {activeGeneration ? 'Planning in progress…' : 'Generate storyboard'}
          </Button>

          {live ? (
            <div className="stack stack-2">
              <Progress value={live.progress} />
              {live.status === 'failed' ? (
                <Alert tone="danger">{live.errorMessage ?? 'Planning failed.'}</Alert>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="grow">Shot list</h2>
          {latest ? <Badge tone="neutral">{latest.shots.length} shots</Badge> : null}
        </div>

        {storyboards.initialLoading ? (
          <LoadingState label="Loading storyboards…" />
        ) : !latest ? (
          <EmptyState
            icon="▦"
            title="No storyboard yet"
            description="Generate one to turn the script into a shot-by-shot plan, or add scenes manually in the Scenes tab."
          />
        ) : (
          <div className="card-body stack stack-3">
            <div className="row row-between">
              <span className="text-sm">{latest.title}</span>
              <span className="text-xs faint">created {relativeTime(latest.createdAt)}</span>
            </div>
            <ol className="stack stack-3" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {latest.shots.map((shot, index) => (
                <li key={`${shot.sceneNumber}-${index}`} className="panel stack stack-2">
                  <div className="row row-between">
                    <span className="row row-2">
                      <span className="scene-index">{shot.sceneNumber}</span>
                      {shot.cameraAngle ? <Badge tone="neutral">{shot.cameraAngle}</Badge> : null}
                    </span>
                    {shot.durationSeconds ? (
                      <span className="text-xs faint">{shot.durationSeconds}s</span>
                    ) : null}
                  </div>
                  <p className="text-sm muted">{shot.description}</p>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>
    </div>
  );
}
