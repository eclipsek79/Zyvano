/**
 * Script workspace.
 *
 * Generation is queued through the API (202) and the resulting generation row is
 * polled until the worker settles it. When a script lands it is loaded for editing;
 * the operator's own edits are saved through PATCH and are never overwritten by a
 * later poll.
 */
import { useEffect, useMemo, useState } from 'react';

import type { GenerationDTO, ProjectDTO } from '@zyvano/shared';

import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  Progress,
  StatusBadge,
  TextAreaField,
  TextField,
  relativeTime,
  useToast,
} from '../ui';
import { generationsApi, scriptsApi } from '../../lib/api';
import { ApiError } from '../../lib/api-client';
import { useAsync, usePolling } from '../../hooks/use-async';
import { usePermissions } from '../../state/auth-context';

interface ScriptPanelProps {
  project: ProjectDTO;
  generations: GenerationDTO[];
  onChanged: () => void;
}

export function ScriptPanel({ project, generations, onChanged }: ScriptPanelProps) {
  const { push } = useToast();
  const { canGenerate, canEdit } = usePermissions();

  const [prompt, setPrompt] = useState(project.prompt ?? '');
  const [tone, setTone] = useState('');
  const [duration, setDuration] = useState(
    project.targetDurationSeconds ? String(project.targetDurationSeconds) : '',
  );
  const [queuing, setQueuing] = useState(false);
  const [trackedId, setTrackedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Draft edits, keyed by script id, so a poll cannot clobber typing in progress.
  const [draft, setDraft] = useState<{ id: string; title: string; content: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // A script created by hand has no server id until it is saved, so it is tracked
  // separately from `draft` rather than being given a placeholder identifier.
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');

  const scripts = useAsync(() => scriptsApi.list(project.id), [project.id]);

  useEffect(() => {
    setPrompt(project.prompt ?? '');
  }, [project.prompt]);

  // Track the generation this panel queued (or the most recent script generation).
  const scriptGenerations = useMemo(
    () => generations.filter((generation) => generation.kind === 'script'),
    [generations],
  );

  const activeGeneration = useMemo(() => {
    if (trackedId) {
      const tracked = scriptGenerations.find((generation) => generation.id === trackedId);
      if (tracked) return tracked;
    }
    return scriptGenerations.find((g) => g.status === 'queued' || g.status === 'processing') ?? null;
  }, [scriptGenerations, trackedId]);

  const { data: polledGeneration } = usePolling(
    () => generationsApi.get(activeGeneration!.id),
    Boolean(activeGeneration),
    2000,
  );

  const live = polledGeneration ?? activeGeneration;

  // When the tracked generation completes, pull the script it produced.
  useEffect(() => {
    if (!live) return;
    if (live.status === 'completed') {
      void scripts.reload();
      onChanged();
      setTrackedId(null);
    } else if (live.status === 'failed') {
      onChanged();
      setTrackedId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.status, live?.id]);

  async function queueGeneration() {
    if (!prompt.trim()) {
      push('error', 'Describe the video before generating a script.');
      return;
    }
    setQueuing(true);
    try {
      const parsedDuration = duration.trim() ? Number.parseInt(duration, 10) : undefined;
      const result = await scriptsApi.generate(project.id, {
        prompt: prompt.trim(),
        ...(tone.trim() ? { tone: tone.trim() } : {}),
        ...(parsedDuration && Number.isFinite(parsedDuration)
          ? { targetDurationSeconds: parsedDuration }
          : {}),
        // A fresh key per intent: retrying the same click reuses the request
        // rather than billing a second provider call.
        idempotencyKey: `script-${project.id}-${Date.now()}`,
      });
      setTrackedId(result.generation.id);
      push(
        'success',
        result.deduplicated
          ? 'An identical request was already queued; tracking it.'
          : 'Script generation queued.',
      );
      onChanged();
    } catch (caught) {
      push('error', describeGenerationError(caught));
    } finally {
      setQueuing(false);
    }
  }

  async function saveScript() {
    if (!draft && !creating) return;

    if (creating) {
      if (!newTitle.trim()) {
        push('error', 'Give the script a title.');
        return;
      }
      if (!newContent.trim()) {
        push('error', 'A script cannot be empty.');
        return;
      }
      setSaving(true);
      try {
        await scriptsApi.create(project.id, {
          title: newTitle.trim(),
          content: newContent,
          // The schema treats language as a required output with a defaulted input, so
          // the client states the project's language explicitly rather than relying on
          // a default the request would never see.
          language: 'en',
        });
        push('success', 'Script created.');
        setCreating(false);
        setNewTitle('');
        setNewContent('');
        await scripts.reload();
        onChanged();
      } catch (caught) {
        push('error', caught instanceof ApiError ? caught.message : 'Save failed.');
      } finally {
        setSaving(false);
      }
      return;
    }

    if (!draft) return;
    if (!draft.content.trim()) {
      push('error', 'A script cannot be empty.');
      return;
    }
    setSaving(true);
    try {
      await scriptsApi.update(draft.id, {
        title: draft.title.trim() || 'Script',
        content: draft.content,
      });
      push('success', 'Script saved.');
      setDraft(null);
      await scripts.reload();
    } catch (caught) {
      push('error', caught instanceof ApiError ? caught.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteScript(scriptId: string) {
    setDeleting(true);
    try {
      await scriptsApi.remove(scriptId);
      push('success', 'Script deleted.');
      setDraft(null);
      await scripts.reload();
    } catch (caught) {
      push('error', caught instanceof ApiError ? caught.message : 'Delete failed.');
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  }

  const scriptList = scripts.data ?? [];
  const editing = creating
    ? { id: 'new', title: newTitle, content: newContent }
    : draft ??
      (scriptList[0]
        ? { id: scriptList[0].id, title: scriptList[0].title, content: scriptList[0].content }
        : null);

  /** Routes an editor change to whichever buffer is active. */
  function editField(field: 'title' | 'content', value: string) {
    if (creating) {
      if (field === 'title') setNewTitle(value);
      else setNewContent(value);
      return;
    }
    if (draft) setDraft({ ...draft, [field]: value });
    else if (scriptList[0]) {
      // Typing into a saved script starts a new draft of it; nothing is lost until
      // the operator saves, and a poll cannot clobber in-progress typing.
      setDraft({
        id: scriptList[0].id,
        title: field === 'title' ? value : scriptList[0].title,
        content: field === 'content' ? value : scriptList[0].content,
      });
    }
  }

  return (
    <div className="grid grid--two">
      <section className="card">
        <div className="card-header">
          <h2 className="grow">Generate a script</h2>
          {live ? <StatusBadge status={live.status} /> : null}
        </div>
        <div className="card-body stack stack-4">
          {!canGenerate ? (
            <Alert tone="info">Your role does not allow starting generation in this workspace.</Alert>
          ) : null}

          <TextAreaField
            label="Creative brief"
            className="textarea--tall"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            hint="What is the video about? Include subject, mood, setting and message."
          />

          <div className="grid grid--two">
            <TextField
              label="Tone"
              value={tone}
              onChange={(event) => setTone(event.target.value)}
              placeholder="warm, confident"
            />
            <TextField
              label="Target length (seconds)"
              type="number"
              min={5}
              max={3600}
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
            />
          </div>

          <Button
            variant="primary"
            onClick={queueGeneration}
            loading={queuing}
            disabled={!canGenerate || Boolean(activeGeneration)}
          >
            {activeGeneration ? 'Generation in progress…' : 'Generate script'}
          </Button>

          {live ? (
            <div className="stack stack-2">
              <div className="row row-between">
                <span className="text-xs faint">
                  {live.provider ?? 'default provider'}
                  {live.model ? ` / ${live.model}` : ''} · queued {relativeTime(live.createdAt)}
                </span>
                <span className="text-xs faint">{live.progress}%</span>
              </div>
              <Progress value={live.progress} />
              {live.status === 'failed' ? (
                <Alert
                  tone="danger"
                  action={
                    <Button
                      size="sm"
                      onClick={async () => {
                        try {
                          await generationsApi.retry(live.id);
                          setTrackedId(live.id);
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
                  {live.errorMessage ?? 'The provider call failed.'}
                  {live.errorCode === 'PROVIDER_NOT_CONFIGURED'
                    ? ' An administrator must configure the text provider before this can run.'
                    : ''}
                </Alert>
              ) : null}
            </div>
          ) : null}

          <p className="text-xs faint">
            Generation runs on a background worker. You can navigate away — the work continues and
            the result is saved to this project.
          </p>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="grow">Script</h2>
          {scriptList.length > 0 ? <Badge tone="neutral">v{scriptList[0]?.version ?? 1}</Badge> : null}
          <Button size="sm" variant="ghost" onClick={() => void scripts.reload()}>
            Refresh
          </Button>
        </div>

        {scripts.initialLoading ? (
          <LoadingState label="Loading scripts…" />
        ) : !editing ? (
          <EmptyState
            icon="✎"
            title="No script yet"
            description="Generate one from your brief, or write the script yourself to control every word."
            action={
              <div className="row row-2 row-wrap">
                <Button
                  variant="primary"
                  disabled={!canEdit}
                  onClick={() => {
                    setCreating(true);
                  }}
                >
                  Write it myself
                </Button>
              </div>
            }
          />
        ) : (
          <div className="card-body stack stack-4">
            {creating ? (
              <Alert tone="info">
                This script is not saved yet. Give it a title and content, then save it to the project.
              </Alert>
            ) : null}
            <TextField
              label="Title"
              value={editing.title}
              onChange={(event) => editField('title', event.target.value)}
              disabled={!canEdit}
            />
            <TextAreaField
              label="Script content"
              className="textarea--tall"
              value={editing.content}
              onChange={(event) => editField('content', event.target.value)}
              disabled={!canEdit}
              hint={
                creating
                  ? undefined
                  : scriptList[0]?.sourceGenerationId
                    ? 'This script was produced by a generation. Edits are saved as your own version.'
                    : undefined
              }
            />
            <div className="row row-between row-wrap">
              <span className="text-xs faint">
                {creating
                  ? 'New script'
                  : `${scriptList.length} version${scriptList.length === 1 ? '' : 's'} · updated ${relativeTime(
                      scriptList[0]?.updatedAt,
                    )}`}
              </span>
              <div className="row row-2">
                {creating ? (
                  <Button
                    size="sm"
                    disabled={saving}
                    onClick={() => {
                      setCreating(false);
                      setNewTitle('');
                      setNewContent('');
                    }}
                  >
                    Cancel
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={!canEdit || !draft}
                    onClick={() => setConfirmDelete(editing.id)}
                  >
                    Delete
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  onClick={saveScript}
                  loading={saving}
                  disabled={!canEdit}
                >
                  Save script
                </Button>
              </div>
            </div>
            {!creating && !draft ? (
              <p className="text-xs faint">Start typing to create a new version of this script.</p>
            ) : null}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this script?"
        message="The script is removed from the project. Generations that produced it are kept for history."
        confirmLabel="Delete script"
        busy={deleting}
        onConfirm={() => (confirmDelete ? deleteScript(confirmDelete) : undefined)}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

/** Turns any generation failure into a message that names the real cause. */
export function describeGenerationError(caught: unknown): string {
  if (!(caught instanceof ApiError)) return 'The request failed unexpectedly.';
  switch (caught.code) {
    case 'PROVIDER_NOT_CONFIGURED':
      return caught.message;
    case 'QUOTA_EXCEEDED':
      return 'This workspace has used its available credits for the period.';
    case 'RATE_LIMITED':
      return 'Too many generation requests. Wait a moment and retry.';
    case 'EMAIL_NOT_VERIFIED':
      return 'Verify your email address before generating.';
    default:
      return caught.message;
  }
}
