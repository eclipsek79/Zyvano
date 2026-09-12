/**
 * Prompt construction for AI text generations.
 *
 * Prompts live in the worker (not the API) because only the worker talks to the
 * provider. Keeping them here also means a prompt change is a worker deploy and
 * never alters the public API contract.
 */
import type { StoryboardShot } from '@zyvano/shared';
import type { TextGenerationRequest } from '@zyvano/server/infrastructure/ai/interfaces';

/** A shot as planned by the model before it becomes a persisted scene. */
export type PlannedShot = StoryboardShot;

const SCRIPT_SYSTEM = [
  'You are a senior commercial video writer for Zyvano, a production tool.',
  'Write scripts that are shootable and specific: concrete subjects, real actions,',
  'observable detail. Never write camera instructions inside narration lines.',
  'Return the script as plain text with a short title, then numbered beats.',
].join(' ');

/** Builds the text-generation request for a video script. */
export function buildScriptMessages(input: {
  projectPrompt: string;
  tone: string | null;
  language: string;
  targetDurationSeconds: number | null;
}): TextGenerationRequest {
  const lines: string[] = [];
  lines.push(`Creative brief: ${input.projectPrompt || 'A short promotional video.'}`);
  if (input.tone) lines.push(`Tone: ${input.tone}.`);
  if (input.targetDurationSeconds) {
    // Narration pace is roughly 2.5 words per second; give the model a budget it
    // can actually honour instead of an unbounded length.
    const words = Math.round(input.targetDurationSeconds * 2.5);
    lines.push(
      `Target runtime: ${input.targetDurationSeconds} seconds, which is about ${words} words of narration.`,
    );
  }
  lines.push(`Write the script in language code "${input.language}".`);
  lines.push(
    'Format: a single title line, then numbered beats. Each beat is one or two sentences of narration.',
  );

  return {
    prompt: lines.join('\n'),
    system: SCRIPT_SYSTEM,
    temperature: 0.7,
    maxOutputTokens: 1500,
  };
}

const STORYBOARD_SYSTEM = [
  'You are a storyboard planner for a video production tool.',
  'For each shot give a single visual description: subject, action, setting, lighting.',
  'Descriptions are used directly as image and video generation prompts, so they must',
  'be concrete and free of references to things that cannot be photographed.',
  'Respond with minified JSON only. No prose, no code fences.',
].join(' ');

/** JSON shape the model must satisfy; also used to validate its output. */
export const STORYBOARD_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['shots'],
  properties: {
    shots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['sceneNumber', 'description'],
        properties: {
          sceneNumber: { type: 'integer' },
          description: { type: 'string' },
          cameraAngle: { type: 'string' },
          durationSeconds: { type: 'number' },
        },
      },
    },
  },
};

/** Builds the text-generation request for a storyboard. */
export function buildStoryboardPrompts(input: {
  sceneCount: number;
  script: string;
  language: string;
}): TextGenerationRequest {
  const prompt = [
    `Write a storyboard of exactly ${input.sceneCount} shots.`,
    input.script ? `Base it on this script:\n${input.script}` : 'Base it on the project brief.',
    `Write descriptions in language code "${input.language}".`,
    'Respond with JSON: {"shots":[{"sceneNumber":1,"description":"...","cameraAngle":"...","durationSeconds":5}]}',
  ].join('\n\n');

  return {
    prompt,
    system: STORYBOARD_SYSTEM,
    temperature: 0.6,
    maxOutputTokens: 2000,
    jsonSchema: STORYBOARD_JSON_SCHEMA,
  };
}

/**
 * Validates and normalises a model's storyboard output. A malformed response is
 * rejected outright rather than being patched into something plausible — scenes
 * derived from invented data would be worse than a clean failure.
 */
export function parseStoryboardResponse(text: string): PlannedShot[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('The storyboard provider returned a response that is not valid JSON.');
  }

  const shots = (parsed as { shots?: unknown }).shots;
  if (!Array.isArray(shots) || shots.length === 0) {
    throw new Error('The storyboard provider returned no shots.');
  }

  const normalised: PlannedShot[] = [];
  for (const [index, raw] of shots.entries()) {
    const shot = raw as Record<string, unknown>;
    const description = typeof shot.description === 'string' ? shot.description.trim() : '';
    if (!description) {
      throw new Error(`Shot ${index + 1} has no description.`);
    }

    const duration =
      typeof shot.durationSeconds === 'number' && shot.durationSeconds > 0
        ? Math.min(30, shot.durationSeconds)
        : 5;

    normalised.push({
      sceneNumber: typeof shot.sceneNumber === 'number' ? shot.sceneNumber : index + 1,
      description: description.slice(0, 2000),
      ...(typeof shot.cameraAngle === 'string' ? { cameraAngle: shot.cameraAngle.slice(0, 200) } : {}),
      durationSeconds: duration,
    });
  }

  return normalised;
}
