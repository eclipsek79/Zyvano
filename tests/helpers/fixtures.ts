/**
 * Shared arrangement helpers for the HTTP-driven suites.
 *
 * Establishing an actor, creating a project and reading a generation's authoritative
 * row are needed by the isolation, lifecycle and job-processing suites alike. They live
 * here so those suites cannot drift apart: a change to how an actor is established (a
 * newly required header, say) must break in one place rather than in whichever file
 * happened to be edited.
 *
 * Every helper drives the real API over HTTP. None of them inserts a session or
 * fabricates a response body, so a broken arrangement surfaces as a real status code
 * instead of a passing test built on invented state. The one exception is email
 * verification, which is a genuine column flip used purely as arrangement — the
 * verification flow itself is covered by the auth suite.
 */
import type { Application } from 'express';
import request from 'supertest';

import { COOKIE_NAMES } from '@zyvano/shared';
import { getPool } from '@zyvano/server/db/pool';

/* ---------------------------------- cookies --------------------------------- */

/** Reads a single cookie value out of a response's `Set-Cookie` headers. */
export function cookieValue(response: request.Response, name: string): string | undefined {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  if (!raw) return undefined;
  for (const entry of raw) {
    const separator = entry.indexOf('=');
    if (separator === -1) continue;
    if (entry.slice(0, separator) !== name) continue;
    const rest = entry.slice(separator + 1);
    const terminator = rest.indexOf(';');
    return terminator === -1 ? rest : rest.slice(0, terminator);
  }
  return undefined;
}

/** Joins a response's cookies into a single `Cookie` request header. */
export function cookieHeader(response: request.Response): string {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? [])
    .map((entry) => entry.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

/* ----------------------------------- actors --------------------------------- */

/** Everything a test needs in order to act as a registered account. */
export interface Actor {
  cookies: string;
  csrf: string;
  userId: string;
  organizationId: string;
}

/**
 * Registers an account, marks its address verified, and returns its acting credentials.
 *
 * Registration is performed through the real endpoint so the returned session cookie and
 * CSRF token are the genuine artifacts the API issued, not values a test constructed.
 */
export async function createActor(app: Application, email: string): Promise<Actor> {
  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: 'lovelace-analytical1', displayName: email.split('@')[0] })
    .set('user-agent', 'vitest');

  if (response.status !== 201) {
    throw new Error(
      `Registration for ${email} failed with ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }

  // Project creation and generation are gated on a verified address. Flipping the column
  // is arrangement; the verification flow is asserted in the auth suite.
  await getPool().query('UPDATE users SET email_verified_at = now() WHERE email = $1', [email]);

  return {
    cookies: cookieHeader(response),
    csrf: cookieValue(response, COOKIE_NAMES.CSRF) ?? '',
    userId: response.body.data.user.id as string,
    organizationId: response.body.data.organizations[0].id as string,
  };
}

/** Attaches an actor's session, CSRF token and active workspace to a request. */
export function asActor(req: request.Test, actor: Actor, organizationId?: string): request.Test {
  return req
    .set('Cookie', actor.cookies)
    .set('x-zyvano-csrf', actor.csrf)
    .set('x-zyvano-organization', organizationId ?? actor.organizationId);
}

/* ----------------------------------- domain --------------------------------- */

/**
 * Creates a project through the API and returns its id.
 *
 * `extra` carries any additional fields the endpoint accepts (a creative brief, for
 * instance) so callers do not have to re-implement the request to add one.
 */
export async function createProject(
  app: Application,
  actor: Actor,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await asActor(request(app).post('/api/v1/projects'), actor).send({
    name,
    ...extra,
  });
  if (response.status !== 201) {
    throw new Error(`Project creation failed with ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body.data.id as string;
}

/** Creates a scene inside a project and returns its id. */
export async function createScene(
  app: Application,
  actor: Actor,
  projectId: string,
  options: { title?: string; prompt?: string; durationSeconds?: number } = {},
): Promise<string> {
  const response = await asActor(
    request(app).post(`/api/v1/projects/${projectId}/scenes`),
    actor,
  ).send({
    title: options.title ?? 'Opening shot',
    prompt: options.prompt ?? 'A slow push across an empty square at sunrise.',
    durationSeconds: options.durationSeconds ?? 4,
  });
  if (response.status !== 201) {
    throw new Error(`Scene creation failed with ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body.data.id as string;
}

/* ------------------------------- authoritative reads ------------------------ */

/** The lifecycle columns of a generation row, read directly from PostgreSQL. */
export interface GenerationRow {
  status: string;
  progress: number;
  error_code: string | null;
  error_message: string | null;
  credits_reserved: number;
  credits_used: number;
  started_at: Date | null;
  finished_at: Date | null;
  cancelled_at: Date | null;
}

/**
 * Reads a generation row directly.
 *
 * The row is the authoritative lifecycle record: what the API reports and what the UI
 * renders are both derived from it, so asserting here is asserting on the source of
 * truth rather than on a projection of it.
 */
export async function generationRow(id: string): Promise<GenerationRow> {
  const result = await getPool().query<GenerationRow>(
    `SELECT status, progress, error_code, error_message, credits_reserved, credits_used,
            started_at, finished_at, cancelled_at
       FROM generations WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Generation ${id} does not exist.`);
  return row;
}

/** Credits currently held against an organization's quota. */
export async function creditsUsed(organizationId: string): Promise<number> {
  const result = await getPool().query<{ credits_used: number }>(
    `SELECT COALESCE(SUM(credits_used), 0)::int AS credits_used
       FROM usage_quotas WHERE organization_id = $1`,
    [organizationId],
  );
  return Number(result.rows[0]?.credits_used ?? 0);
}
