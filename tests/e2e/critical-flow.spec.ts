/**
 * End-to-end coverage of Zyvano's critical creative workflow.
 *
 * This drives a real browser against the real application: a real API, a real worker
 * consuming a real queue, a real PostgreSQL database, real object storage and a real
 * ffmpeg render. The third-party AI vendors and the SMTP server are stood in for by
 * local processes that speak the genuine protocols (see `scripts/e2e-env.mjs`),
 * because the real ones need credentials this environment does not have.
 *
 * The workflow asserted here is the product's acceptance path:
 *   Register -> verify email -> Sign in -> Create project -> Create script ->
 *   Generate -> wait for completion -> view the result -> export -> download a
 *   verified file.
 *
 * Two rules are followed throughout:
 *   1. Every UI claim is cross-checked against the server's own state. Nothing is
 *      accepted on the strength of an optimistic update or a toast.
 *   2. Where a value lives in a form control (a textarea's value), it is asserted
 *      through the API rather than by scraping rendered text, because a control's
 *      value is not page text.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Unique per run, so repeated runs never collide on the unique email constraint. */
const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const EMAIL = `director.${RUN_ID}@example.com`;
const PASSWORD = 'Lovelace-Analytical1';
const DISPLAY_NAME = 'Ada Director';
const PROJECT_NAME = `Launch film ${RUN_ID}`;

/** A second identity, so this file's two specs never depend on each other's state. */
const SECOND_EMAIL = `producer.${RUN_ID}@example.com`;
const SECOND_PROJECT = `Second film ${RUN_ID}`;

/** Path of the SMTP sink's capture file, written by `scripts/e2e-env.mjs`. */
const MAILBOX_PATH = path.join(process.cwd(), 'storage-e2e', 'mailbox.json');

interface CapturedMail {
  to: string[];
  raw: string;
}

/**
 * Decodes a quoted-printable message body.
 *
 * Mail clients encode bodies this way when a line would be too long or contains
 * non-ASCII bytes: `=` becomes `=3D`, and a trailing `=` marks a soft line break. The
 * capture sink records the message exactly as it arrived, so the encoding must be
 * undone before a link inside it is usable — otherwise the token silently contains the
 * escape digits and verification fails for a reason that looks like a bad token.
 */
function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Waits for the verification email to arrive at the capture sink and returns its link.
 *
 * The application sends through its real SMTP mailer, so this reads a genuine message
 * off the wire rather than reaching into the database for a token.
 */
async function waitForVerificationLink(
  page: Page,
  timeoutMs = 30_000,
  recipient: string = EMAIL,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const messages = JSON.parse(readFileSync(MAILBOX_PATH, 'utf8')) as CapturedMail[];
      const message = messages.find((entry) => entry.to.includes(recipient));
      if (message) {
        const body = decodeQuotedPrintable(message.raw);
        const match = body.match(/https?:\/\/[^\s"'<>]*verify-email\?token=[^\s"'<>]+/);
        if (match) {
          return match[0].replace(/&amp;/g, '&');
        }
      }
    } catch {
      // The file may not exist yet, or be mid-write. Retry.
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for a verification email for ${recipient}`);
    }
    await page.waitForTimeout(300);
  }
}

/** Reads a JSON endpoint through the browser's own authenticated session. */
async function apiGet<T>(page: Page, url: string): Promise<T> {
  const response = await page.request.get(url);
  expect(response.status(), `GET ${url}`).toBe(200);
  return (await response.json()) as T;
}

/** Waits until the project's scripts include text produced by the provider. */
async function waitForScriptContaining(page: Page, projectId: string, needle: RegExp): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const body = await apiGet<{ data: Array<{ content: string }> }>(
      page,
      `/api/v1/projects/${projectId}/scripts`,
    );
    if (body.data.some((script) => needle.test(script.content))) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for a script matching ${needle}`);
    }
    await page.waitForTimeout(500);
  }
}

/** Selects a workspace tab and confirms it is the active one. */
async function openTab(page: Page, label: string): Promise<void> {
  const tab = page.getByRole('tab', { name: label });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

test.describe('Zyvano critical workflow', () => {
  test('register, verify, create a project and script, generate, render a clip, and export a verified file', async ({
    page,
  }) => {
    test.slow();

    /* ------------------------------ 1. Registration ----------------------------- */

    await page.goto('/register');
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();

    await page.getByLabel('Your name').fill(DISPLAY_NAME);
    await page.getByLabel('Email').fill(EMAIL);
    // Required fields render their label with a trailing " *", so an exact match on
    // "Password" would never resolve. The anchored prefix is unambiguous here.
    await page.getByLabel(/^Password/).fill(PASSWORD);
    await page.getByLabel('Workspace name').fill(`Studio ${RUN_ID}`);
    await page.getByRole('button', { name: 'Create account' }).click();

    // Registration issues a session, so the studio is reached without a second step.
    await expect(page.getByRole('heading', { name: 'Studio' })).toBeVisible({ timeout: 30_000 });

    /* ---------------------------- 2. Email verification ------------------------- */

    // Project creation and generation are gated on a verified address, so this is a
    // required step of the real workflow rather than a convenience.
    const verifyLink = await waitForVerificationLink(page);
    await page.goto(verifyLink);
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
    await page.getByRole('button', { name: 'Verify email' }).click();
    await expect(page.getByText('Your email is verified.')).toBeVisible({ timeout: 30_000 });

    /* --------------------------------- 3. Sign in ------------------------------- */

    // A full round trip through the sign-in form proves credentials are checked
    // against the stored hash. The first attempt uses a wrong password deliberately.
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });

    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel(/^Password/).fill('definitely-not-the-password1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 30_000 });
    // The failed attempt did not grant access.
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel(/^Password/).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Studio' })).toBeVisible({ timeout: 30_000 });

    /* ------------------------------ 4. Create project --------------------------- */

    await page.getByRole('button', { name: 'New project' }).click();
    const projectDialog = page.getByRole('dialog');
    await expect(projectDialog).toBeVisible();
    await projectDialog.getByLabel('Project name').fill(PROJECT_NAME);
    await projectDialog
      .getByLabel('Creative brief')
      .fill('A 30-second launch film for a solar-powered backpack, golden-hour hiking footage.');
    await projectDialog.getByRole('button', { name: 'Create project' }).click();

    // Creating a project opens its workspace.
    await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible({ timeout: 30_000 });
    const projectUrl = page.url();
    const projectId = projectUrl.split('/projects/')[1]!.split(/[?#]/)[0]!;

    /* ------------------------------- 5. Create script --------------------------- */

    await openTab(page, 'Script');
    await expect(page.getByRole('heading', { name: 'Generate a script' })).toBeVisible();

    // A script written by hand proves the editor path independently of the AI path,
    // so a provider problem can never be mistaken for a broken editor.
    await page.getByRole('button', { name: 'Write it myself' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Opening');
    await page
      .getByLabel('Script content')
      .fill('Before the traffic, a single cart rolls into the square.');
    await page.getByRole('button', { name: 'Save script' }).click();

    await waitForScriptContaining(page, projectId, /single cart rolls/);
    // The panel reports the persisted version count from the server.
    await expect(page.getByText(/1 version/)).toBeVisible({ timeout: 30_000 });

    /* ------------------------- 6. Generate (real provider) ---------------------- */

    await page.getByLabel('Creative brief').fill('A film about a city waking up.');
    await page.getByRole('button', { name: 'Generate script' }).click();

    // Completion is proven by the provider's own words arriving, persisted.
    await waitForScriptContaining(page, projectId, /City at First Light/);
    await expect(page.getByText(/2 versions/)).toBeVisible({ timeout: 60_000 });

    /* --------------------------- 7. Storyboard and scenes ----------------------- */

    await openTab(page, 'Storyboard');
    await page.getByRole('button', { name: 'Generate storyboard' }).click();

    await openTab(page, 'Scenes');
    // Scenes appear only after the worker persisted them from the storyboard.
    await expect(page.locator('.scene-item').first()).toBeVisible({ timeout: 120_000 });
    const scenesBody = await apiGet<{ data: Array<{ id: string; prompt: string | null }> }>(
      page,
      `/api/v1/projects/${projectId}/scenes`,
    );
    expect(scenesBody.data.length).toBeGreaterThan(0);

    /* ----------------------------- 8. Render a clip ----------------------------- */

    await page.getByRole('button', { name: 'Render clip' }).first().click();

    // Wait for the server to report a scene with real media attached, then confirm a
    // preview element backed by the authorized content endpoint is rendered.
    const deadline = Date.now() + 150_000;
    let renderedSceneId: string | null = null;
    for (;;) {
      const body = await apiGet<{ data: Array<{ id: string; previewAssetId: string | null }> }>(
        page,
        `/api/v1/projects/${projectId}/scenes`,
      );
      const rendered = body.data.find((scene) => scene.previewAssetId);
      if (rendered) {
        renderedSceneId = rendered.id;
        break;
      }
      if (Date.now() > deadline) throw new Error('Timed out waiting for a rendered scene');
      await page.waitForTimeout(1000);
    }

    const preview = page.locator('.scene-item img, .scene-item video').first();
    await expect(preview).toBeVisible({ timeout: 60_000 });
    const previewSrc = await preview.getAttribute('src');
    expect(previewSrc).toBeTruthy();

    // The preview URL really serves bytes: an authorized request returns media, not
    // an error page. Without this a broken storage key could still look fine in the UI.
    const previewResponse = await page.request.get(previewSrc!);
    expect(previewResponse.status()).toBe(200);
    expect((await previewResponse.body()).byteLength).toBeGreaterThan(1000);

    /* --------------------------------- 9. Export -------------------------------- */

    await openTab(page, 'Exports');
    await expect(page.getByRole('heading', { name: 'Render an export' })).toBeVisible();
    await page.getByRole('button', { name: 'Queue export' }).click();

    // The export row only shows a Download button once the backend has confirmed the
    // rendered file exists and is accessible.
    const downloadButton = page.getByRole('button', { name: 'Download' }).first();
    await expect(downloadButton).toBeVisible({ timeout: 180_000 });

    /* --------------------------- 10. Retrieve the file -------------------------- */

    // The envelope is `{ data: [...], meta }` for every list endpoint, so `data` is the
    // array itself rather than an object wrapping one. The list projection deliberately
    // omits `files` — that array is carried by the detail response below, so a list of
    // exports does not fan out into a per-row file query.
    const exportsBody = await apiGet<{
      data: Array<{ id: string; status: string; verified: boolean }>;
    }>(page, `/api/v1/exports?perPage=5&sort=createdAt&order=desc`);
    const exportRow = exportsBody.data[0]!;
    expect(exportRow.status).toBe('completed');
    expect(exportRow.verified).toBe(true);

    const exportDetail = await apiGet<{
      data: { id: string; status: string; verified: boolean; files: Array<{ url: string }> };
    }>(page, `/api/v1/exports/${exportRow.id}`);
    expect(exportDetail.data.status).toBe('completed');
    expect(exportDetail.data.verified).toBe(true);
    expect(exportDetail.data.files.length).toBeGreaterThan(0);
    expect(exportDetail.data.files[0]!.url).toBeTruthy();

    const downloadResponse = await page.request.get(`/api/v1/exports/${exportRow.id}/download`);
    expect(downloadResponse.status()).toBe(200);
    const downloadMeta = (await downloadResponse.json()) as {
      data: { url: string; filename: string };
    };
    expect(downloadMeta.data.filename).toContain(exportRow.id);

    // The master file is a real MP4 container with real content, not an empty artifact.
    const fileResponse = await page.request.get(downloadMeta.data.url);
    expect(fileResponse.status()).toBe(200);
    const fileBytes = await fileResponse.body();
    expect(fileBytes.byteLength).toBeGreaterThan(10_000);
    expect(fileBytes.subarray(4, 8).toString('ascii')).toBe('ftyp');

    /* --------------------------- 11. State survives reload ---------------------- */

    // Reloading proves every step is persisted server-side rather than held in client
    // memory: a browser refresh must not lose the project, its script, its rendered
    // clip or its export.
    await page.goto(projectUrl);
    await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible({ timeout: 30_000 });

    await openTab(page, 'Script');
    await waitForScriptContaining(page, projectId, /City at First Light/);

    await openTab(page, 'Exports');
    await expect(page.getByRole('button', { name: 'Download' }).first()).toBeVisible({
      timeout: 30_000,
    });

    await openTab(page, 'Scenes');
    await expect(page.locator('.scene-item img, .scene-item video').first()).toBeVisible({
      timeout: 60_000,
    });
    expect(renderedSceneId).toBeTruthy();
  });

  test('unauthenticated visitors are redirected, and destructive actions require confirmation', async ({
    page,
  }) => {
    test.slow();

    // Authorization is enforced by the API, not the router: requesting a protected
    // page without a session lands on the sign-in screen.
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login/);

    // This spec registers its own account. Sharing the first spec's user would make
    // the two tests order-dependent, and Playwright does not guarantee order.
    await page.goto('/register');
    await page.getByLabel('Your name').fill('Grace Producer');
    await page.getByLabel('Email').fill(SECOND_EMAIL);
    await page.getByLabel(/^Password/).fill(PASSWORD);
    await page.getByLabel('Workspace name').fill(`Studio two ${RUN_ID}`);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Studio' })).toBeVisible({ timeout: 30_000 });

    // Project creation is gated on a verified address, so verification is part of the
    // real flow here too.
    const verifyLink = await waitForVerificationLink(page, 30_000, SECOND_EMAIL);
    await page.goto(verifyLink);
    await page.getByRole('button', { name: 'Verify email' }).click();
    await expect(page.getByText('Your email is verified.')).toBeVisible({ timeout: 30_000 });

    await page.goto('/');
    await page.getByRole('button', { name: 'New project' }).click();
    const projectDialog = page.getByRole('dialog');
    await projectDialog.getByLabel('Project name').fill(SECOND_PROJECT);
    await projectDialog.getByLabel('Creative brief').fill('A short product film.');
    await projectDialog.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { name: SECOND_PROJECT })).toBeVisible({ timeout: 30_000 });

    // Deleting a project is destructive, so it must be confirmed explicitly.
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const confirmDialog = page.getByRole('dialog');
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog.getByText('Delete this project?')).toBeVisible();

    // Cancelling must genuinely cancel: the project is still there afterwards, which
    // is verified against the API rather than from the page alone.
    await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmDialog).toBeHidden();
    await expect(page.getByRole('heading', { name: SECOND_PROJECT })).toBeVisible();

    const projectId = page.url().split('/projects/')[1]!.split(/[?#]/)[0]!;
    const stillThere = await page.request.get(`/api/v1/projects/${projectId}`);
    expect(stillThere.status()).toBe(200);
    const body = (await stillThere.json()) as { data: { status: string } };
    expect(body.data.status).not.toBe('deleted');
  });
});
