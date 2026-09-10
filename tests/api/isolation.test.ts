/**
 * Tenant and resource isolation.
 *
 * The highest-value security tests in the suite. Each one attempts the access an
 * attacker would actually try — reading and mutating another account's project,
 * scene, asset, generation and export — and asserts the server refuses. A failure
 * here means IDOR.
 *
 * Refusals are asserted as 404 for read paths on purpose: the API answers
 * "not found" rather than "forbidden" so an attacker cannot probe for the
 * existence of another tenant's identifiers.
 */
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { COOKIE_NAMES } from '@zyvano/shared';

import { buildTestApp, closeHarness, resetDatabase } from '../helpers/app';

const app = buildTestApp();

function cookieValue(response: request.Response, name: string): string | undefined {
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

function cookieHeader(response: request.Response): string {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((entry) => entry.split(';')[0]).filter(Boolean).join('; ');
}

/**
 * Registers an account, verifies it, and returns everything a test needs to act
 * as that account.
 */
async function createActor(email: string) {
  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: 'lovelace-analytical1', displayName: email.split('@')[0] })
    .set('user-agent', 'vitest');

  const { getPool } = await import('@zyvano/server/db/pool');
  await getPool().query('UPDATE users SET email_verified_at = now() WHERE email = $1', [email]);

  return {
    cookies: cookieHeader(response),
    csrf: cookieValue(response, COOKIE_NAMES.CSRF) ?? '',
    userId: response.body.data.user.id as string,
    organizationId: response.body.data.organizations[0].id as string,
  };
}

async function createProject(actor: Awaited<ReturnType<typeof createActor>>, name: string) {
  const response = await request(app)
    .post('/api/v1/projects')
    .set('Cookie', actor.cookies)
    .set('x-zyvano-csrf', actor.csrf)
    .set('x-zyvano-organization', actor.organizationId)
    .send({ name });

  expect(response.status, `project creation should succeed: ${JSON.stringify(response.body)}`).toBe(
    201,
  );
  return response.body.data;
}

/** Creates a scene inside a project owned by the given actor. */
async function createScene(
  actor: Awaited<ReturnType<typeof createActor>>,
  projectId: string,
  title: string,
) {
  const response = await request(app)
    .post(`/api/v1/projects/${projectId}/scenes`)
    .set('Cookie', actor.cookies)
    .set('x-zyvano-csrf', actor.csrf)
    .set('x-zyvano-organization', actor.organizationId)
    .send({ title, prompt: 'A wide shot at golden hour.', durationSeconds: 4 });

  expect(response.status, `scene creation should succeed: ${JSON.stringify(response.body)}`).toBe(201);
  return response.body.data;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeHarness();
});

describe('cross-account isolation', () => {
  it('does not let one account read another account project', async () => {
    const alice = await createActor('alice@example.com');
    const bob = await createActor('bob@example.com');

    const project = await createProject(alice, 'Alice confidential launch');

    const attempt = await request(app)
      .get(`/api/v1/projects/${project.id}`)
      .set('Cookie', bob.cookies)
      .set('x-zyvano-organization', bob.organizationId);

    expect(attempt.status).toBe(404);
    // The response must not leak the name of the resource that was probed.
    expect(JSON.stringify(attempt.body)).not.toContain('Alice confidential launch');
  });

  it('does not let one account list another account projects', async () => {
    const alice = await createActor('alice2@example.com');
    const bob = await createActor('bob2@example.com');

    await createProject(alice, 'Alice only');

    const listing = await request(app)
      .get('/api/v1/projects')
      .set('Cookie', bob.cookies)
      .set('x-zyvano-organization', bob.organizationId);

    expect(listing.status).toBe(200);
    expect(listing.body.data).toHaveLength(0);
    expect(JSON.stringify(listing.body)).not.toContain('Alice only');
  });

  it('does not let one account modify another account project', async () => {
    const alice = await createActor('alice3@example.com');
    const bob = await createActor('bob3@example.com');

    const project = await createProject(alice, 'Alice immutable');

    const attempt = await request(app)
      .patch(`/api/v1/projects/${project.id}`)
      .set('Cookie', bob.cookies)
      .set('x-zyvano-csrf', bob.csrf)
      .set('x-zyvano-organization', bob.organizationId)
      .send({ name: 'Hijacked' });

    expect(attempt.status).toBe(404);

    // The original must be untouched.
    const reread = await request(app)
      .get(`/api/v1/projects/${project.id}`)
      .set('Cookie', alice.cookies)
      .set('x-zyvano-organization', alice.organizationId);
    expect(reread.body.data.name).toBe('Alice immutable');
  });

  it('does not let one account delete another account project', async () => {
    const alice = await createActor('alice4@example.com');
    const bob = await createActor('bob4@example.com');

    const project = await createProject(alice, 'Alice survivable');

    const attempt = await request(app)
      .delete(`/api/v1/projects/${project.id}`)
      .set('Cookie', bob.cookies)
      .set('x-zyvano-csrf', bob.csrf)
      .set('x-zyvano-organization', bob.organizationId)
      .set('x-zyvano-confirm', 'Alice survivable');

    expect(attempt.status).toBe(404);

    const reread = await request(app)
      .get(`/api/v1/projects/${project.id}`)
      .set('Cookie', alice.cookies)
      .set('x-zyvano-organization', alice.organizationId);
    expect(reread.status).toBe(200);
  });

  it('does not let one account read another account scenes through the project path', async () => {
    const alice = await createActor('alice5@example.com');
    const bob = await createActor('bob5@example.com');

    const project = await createProject(alice, 'Alice scenes');
    const scene = await createScene(alice, project.id, 'Alice establishing shot');

    const attempt = await request(app)
      .get(`/api/v1/projects/${project.id}/scenes`)
      .set('Cookie', bob.cookies)
      .set('x-zyvano-organization', bob.organizationId);

    expect(attempt.status).toBe(404);
    expect(JSON.stringify(attempt.body)).not.toContain('Alice establishing shot');

    // Writing through the nested path must be refused as well.
    const write = await request(app)
      .post(`/api/v1/projects/${project.id}/scenes`)
      .set('Cookie', bob.cookies)
      .set('x-zyvano-csrf', bob.csrf)
      .set('x-zyvano-organization', bob.organizationId)
      .send({ title: 'Injected', durationSeconds: 3 });

    expect(write.status).toBe(404);

    const stillOne = await request(app)
      .get(`/api/v1/projects/${project.id}/scenes`)
      .set('Cookie', alice.cookies)
      .set('x-zyvano-organization', alice.organizationId);
    expect(stillOne.body.data).toHaveLength(1);
    expect(stillOne.body.data[0].id).toBe(scene.id);
  });

  it('does not let one account read another account assets', async () => {
    const alice = await createActor('alice6@example.com');
    const bob = await createActor('bob6@example.com');

    const { getPool } = await import('@zyvano/server/db/pool');
    const project = await createProject(alice, 'Alice assets');
    const asset = await getPool().query<{ id: string }>(
      `INSERT INTO assets (organization_id, project_id, owner_id, kind, source, storage_key,
                           filename, mime_type, size_bytes)
       VALUES ($1, $2, $3, 'image', 'upload', 'org/alice/secret.png',
               'secret.png', 'image/png', 1024)
       RETURNING id`,
      [alice.organizationId, project.id, alice.userId],
    );

    const attempt = await request(app)
      .get(`/api/v1/assets/${asset.rows[0]!.id}`)
      .set('Cookie', bob.cookies)
      .set('x-zyvano-organization', bob.organizationId);

    expect(attempt.status).toBe(404);

    // The byte stream must be protected too, not just the metadata record.
    const content = await request(app)
      .get(`/api/v1/assets/${asset.rows[0]!.id}/content`)
      .set('Cookie', bob.cookies)
      .set('x-zyvano-organization', bob.organizationId);

    expect(content.status).toBe(404);
  });

  it('does not let one account read another account generations', async () => {
    const alice = await createActor('alice7@example.com');
    const bob = await createActor('bob7@example.com');

    const { getPool } = await import('@zyvano/server/db/pool');
    const project = await createProject(alice, 'Alice generations');
    const generation = await getPool().query<{ id: string }>(
      `INSERT INTO generations (organization_id, project_id, requested_by, kind, capability, status, prompt)
       VALUES ($1, $2, $3, 'script', 'text', 'queued', 'Write a launch script.')
       RETURNING id`,
      [alice.organizationId, project.id, alice.userId],
    );

    const attempt = await request(app)
      .get(`/api/v1/generations/${generation.rows[0]!.id}`)
      .set('Cookie', bob.cookies)
      .set('x-zyvano-organization', bob.organizationId);

    expect(attempt.status).toBe(404);
  });

  it('does not let one account cancel another account generation', async () => {
    const alice = await createActor('alice8@example.com');
    const bob = await createActor('bob8@example.com');

    const { getPool } = await import('@zyvano/server/db/pool');
    const project = await createProject(alice, 'Alice cancellable');
    const generation = await getPool().query<{ id: string }>(
      `INSERT INTO generations (organization_id, project_id, requested_by, kind, capability, status, prompt)
       VALUES ($1, $2, $3, 'video', 'video', 'processing', 'Render a clip.')
       RETURNING id`,
      [alice.organizationId, project.id, alice.userId],
    );

    const attempt = await request(app)
      .post(`/api/v1/generations/${generation.rows[0]!.id}/cancel`)
      .set('Cookie', bob.cookies)
      .set('x-zyvano-csrf', bob.csrf)
      .set('x-zyvano-organization', bob.organizationId);

    expect(attempt.status).toBe(404);

    const check = await getPool().query<{ status: string }>(
      'SELECT status FROM generations WHERE id = $1',
      [generation.rows[0]!.id],
    );
    expect(check.rows[0]?.status).toBe('processing');
  });

  it('does not let one account download another account export', async () => {
    const alice = await createActor('alice9@example.com');
    const bob = await createActor('bob9@example.com');

    const { getPool } = await import('@zyvano/server/db/pool');
    const project = await createProject(alice, 'Alice exports');
    const exported = await getPool().query<{ id: string }>(
      `INSERT INTO exports (organization_id, project_id, requested_by, status, preset, progress)
       VALUES ($1, $2, $3, 'completed', 'web-1080p', 100)
       RETURNING id`,
      [alice.organizationId, project.id, alice.userId],
    );

    const attempt = await request(app)
      .get(`/api/v1/exports/${exported.rows[0]!.id}/download`)
      .set('Cookie', bob.cookies)
      .set('x-zyvano-organization', bob.organizationId);

    expect(attempt.status).toBe(404);
  });
});

describe('organization scoping', () => {
  it('refuses an organization header the caller is not a member of', async () => {
    const alice = await createActor('scope-a@example.com');
    const bob = await createActor('scope-b@example.com');

    // Bob presents Alice's organization id. Membership is checked server-side, so
    // the request must be rejected rather than silently served.
    const attempt = await request(app)
      .get('/api/v1/projects')
      .set('Cookie', bob.cookies)
      .set('x-zyvano-organization', alice.organizationId);

    expect([403, 404]).toContain(attempt.status);
  });

  it('scopes the project list to the organization in the header', async () => {
    const alice = await createActor('scope-c@example.com');
    const bob = await createActor('scope-d@example.com');

    await createProject(alice, 'Org one project');
    await createProject(bob, 'Org two project');

    const aliceList = await request(app)
      .get('/api/v1/projects')
      .set('Cookie', alice.cookies)
      .set('x-zyvano-organization', alice.organizationId);

    expect(aliceList.status).toBe(200);
    expect(aliceList.body.data).toHaveLength(1);
    expect(aliceList.body.data[0].name).toBe('Org one project');
  });

  it('refuses a membership change attempted by a non-admin', async () => {
    const alice = await createActor('member-a@example.com');
    const bob = await createActor('member-b@example.com');

    // Add Bob to Alice's workspace as a viewer, then have him try to invite.
    const { getPool } = await import('@zyvano/server/db/pool');
    await getPool().query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'viewer')`,
      [alice.organizationId, bob.userId],
    );

    const attempt = await request(app)
      .post(`/api/v1/organizations/${alice.organizationId}/invitations`)
      .set('Cookie', bob.cookies)
      .set('x-zyvano-csrf', bob.csrf)
      .set('x-zyvano-organization', alice.organizationId)
      .send({ email: 'accomplice@example.com', role: 'admin' });

    expect(attempt.status).toBe(403);
  });

  it('refuses to let a viewer delete a project', async () => {
    const alice = await createActor('viewer-a@example.com');
    const bob = await createActor('viewer-b@example.com');

    const { getPool } = await import('@zyvano/server/db/pool');
    const project = await createProject(alice, 'Protected project');

    await getPool().query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'viewer')`,
      [alice.organizationId, bob.userId],
    );

    const attempt = await request(app)
      .delete(`/api/v1/projects/${project.id}`)
      .set('Cookie', bob.cookies)
      .set('x-zyvano-csrf', bob.csrf)
      .set('x-zyvano-organization', alice.organizationId)
      .set('x-zyvano-confirm', 'Protected project');

    expect(attempt.status).toBe(403);
  });
});

describe('destructive action confirmation', () => {
  it('refuses a project delete without the name confirmation header', async () => {
    const alice = await createActor('confirm@example.com');
    const project = await createProject(alice, 'Needs confirmation');

    const attempt = await request(app)
      .delete(`/api/v1/projects/${project.id}`)
      .set('Cookie', alice.cookies)
      .set('x-zyvano-csrf', alice.csrf)
      .set('x-zyvano-organization', alice.organizationId);

    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect(attempt.status).toBeLessThan(500);
  });

  it('refuses a delete confirmed with the wrong name', async () => {
    const alice = await createActor('confirm2@example.com');
    const project = await createProject(alice, 'Exact name required');

    const attempt = await request(app)
      .delete(`/api/v1/projects/${project.id}`)
      .set('Cookie', alice.cookies)
      .set('x-zyvano-csrf', alice.csrf)
      .set('x-zyvano-organization', alice.organizationId)
      .set('x-zyvano-confirm', 'A different name');

    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect(attempt.status).toBeLessThan(500);
  });
});

describe('input validation on identifiers', () => {
  it('returns a validation error rather than a crash for a malformed project id', async () => {
    const alice = await createActor('malformed@example.com');

    const attempt = await request(app)
      .get('/api/v1/projects/not-a-uuid')
      .set('Cookie', alice.cookies)
      .set('x-zyvano-organization', alice.organizationId);

    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect(attempt.status).toBeLessThan(500);
    // Internal details must never reach the client.
    expect(JSON.stringify(attempt.body)).not.toMatch(/pg_|SELECT|syntax error/i);
  });

  it('does not accept an SQL fragment as an identifier', async () => {
    const alice = await createActor('sqli@example.com');

    const attempt = await request(app)
      .get("/api/v1/projects/1'; DROP TABLE projects; --")
      .set('Cookie', alice.cookies)
      .set('x-zyvano-organization', alice.organizationId);

    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect(attempt.status).toBeLessThan(500);

    // The table must still exist and be queryable.
    const stillWorks = await request(app)
      .get('/api/v1/projects')
      .set('Cookie', alice.cookies)
      .set('x-zyvano-organization', alice.organizationId);
    expect(stillWorks.status).toBe(200);
  });
});
