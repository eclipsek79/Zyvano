/**
 * Brings up the complete Zyvano stack for the end-to-end suite, and tears it down.
 *
 * Playwright runs this file (see `webServer` in playwright.config.ts) and waits for
 * the web URL to answer. Because it is the managed process, it can also shut
 * everything down: Playwright kills its process tree on completion, and the signal
 * handlers below stop each child explicitly so no API, worker or stub is left
 * holding a port or a database connection.
 *
 * The stack is the real one:
 *   - provider contract server  stands in for the third-party AI vendors, which need
 *                               credentials this environment does not have. It speaks
 *                               their published wire protocols, so the real adapters
 *                               run unmodified against it.
 *   - SMTP sink                 a real SMTP server on loopback. The suite therefore
 *                               exercises genuine email delivery rather than bypassing
 *                               it: the verification link is captured off the wire and
 *                               opened in the browser.
 *   - API                       real Express app, real PostgreSQL, real Redis.
 *   - worker                    real handler table, real BullMQ consumer.
 *   - web                       real Vite dev server proxying /api to the API.
 *
 * The database is created if missing, migrated through the application's own runner and
 * emptied before each run, so a run is reproducible and no fixture from an earlier run
 * can satisfy an assertion.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const API_PORT = Number(process.env.E2E_API_PORT ?? 4000);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5173);
const STUB_PORT = Number(process.env.PROVIDER_STUB_PORT ?? 4600);
const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 2525);
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

/** Absolute path of the captured-mail file the Playwright spec reads. */
const MAILBOX_PATH = path.join(repoRoot, 'storage-e2e', 'mailbox.json');

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgresql://zyvano:zyvano@127.0.0.1:5432/zyvano_e2e_test';
const ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ?? 'postgresql://zyvano:zyvano@127.0.0.1:5432/postgres';

const E2E_DATABASE_NAME = (() => {
  try {
    return new URL(E2E_DATABASE_URL).pathname.replace(/^\//, '');
  } catch {
    return 'zyvano_e2e_test';
  }
})();

const children = [];

/* --------------------------------- utilities -------------------------------- */

function spawnChild(label, command, args, env, cwd = repoRoot) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const forward = (stream, sink) => {
    if (!stream) return;
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length > 0) sink.write(`[${label}] ${line}\n`);
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    if (code !== 0 && signal === null) {
      process.stderr.write(`[${label}] exited with code ${code}\n`);
    }
  });

  children.push(child);
  return child;
}

async function waitForHttp(url, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label} at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

async function waitForPort(port, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label} on port ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** Runs a command to completion, rejecting on a non-zero exit. */
async function run(command, args, env = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
    });
  });
}

/* ------------------------------- SMTP capture -------------------------------- */

/**
 * A minimal SMTP server that records the messages it accepts.
 *
 * This is a real SMTP conversation (greeting, EHLO, MAIL FROM, RCPT TO, DATA), which
 * is what makes the email-verification path genuinely covered: the application sends
 * through its real SMTP mailer and the suite reads the resulting message off the wire,
 * instead of reaching into the database for a token.
 *
 * Only what a mail client needs to complete a delivery is implemented. No STARTTLS is
 * advertised, so the client proceeds in the clear on loopback.
 */
function startSmtpSink() {
  mkdirSync(path.dirname(MAILBOX_PATH), { recursive: true });
  writeFileSync(MAILBOX_PATH, '[]\n');

  const readMailbox = () => {
    try {
      return JSON.parse(readFileSync(MAILBOX_PATH, 'utf8'));
    } catch {
      return [];
    }
  };

  const append = (message) => {
    const all = readMailbox();
    all.push(message);
    writeFileSync(MAILBOX_PATH, `${JSON.stringify(all, null, 2)}\n`);
  };

  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    let from = '';
    const recipients = [];

    socket.write('220 zyvano-e2e ESMTP\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      for (;;) {
        if (inData) {
          const crlfEnd = buffer.indexOf('\r\n.\r\n');
          const lfEnd = buffer.indexOf('\n.\n');
          const index = crlfEnd !== -1 ? crlfEnd : lfEnd;
          if (index === -1) break;
          const length = crlfEnd !== -1 ? 5 : 3;
          data += buffer.slice(0, index);
          buffer = buffer.slice(index + length);
          inData = false;

          append({
            from,
            to: [...recipients],
            receivedAt: new Date().toISOString(),
            // Undo dot-stuffing so the captured body is faithful.
            raw: data.replace(/\r\n\.\./g, '\r\n.'),
          });
          recipients.length = 0;
          data = '';
          socket.write('250 2.0.0 Ok: queued\r\n');
          continue;
        }

        const newline = buffer.indexOf('\r\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const upper = line.toUpperCase();

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-zyvano-e2e\r\n250-SIZE 26214400\r\n250 8BITMIME\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          from = line.slice(line.indexOf(':') + 1).trim().replace(/^<|>$/g, '');
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          recipients.push(line.slice(line.indexOf(':') + 1).trim().replace(/^<|>$/g, ''));
          socket.write('250 2.1.5 Ok\r\n');
        } else if (upper.startsWith('AUTH')) {
          // Credentials are accepted without validation: this sink must never require
          // a real secret in order to complete a delivery.
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (upper.startsWith('DATA')) {
          inData = true;
          data = '';
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper.startsWith('QUIT')) {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
      }
    });

    socket.on('error', () => {
      /* The client may reset the connection after QUIT; nothing to do. */
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SMTP_PORT, '127.0.0.1', () => resolve(server));
  });
}

/* --------------------------------- database --------------------------------- */

/**
 * Prepares the E2E database: create it if it is missing, apply migrations through the
 * application's own runner, then empty the tables so a repeat run is reproducible.
 *
 * The schema is not recreated each run: migrations are the thing under test, and
 * dropping the database would mean replaying every migration on every invocation. The
 * table emptying is still complete, so no row from an earlier run can satisfy an
 * assertion.
 *
 * Guarded on the name ending in `_test` before anything destructive runs, so this can
 * never drop or truncate a development or production database.
 */
async function prepareDatabase() {
  if (!/_test$/.test(E2E_DATABASE_NAME)) {
    throw new Error(`Refusing to prepare "${E2E_DATABASE_NAME}": the name must end in _test.`);
  }

  const { stdout } = await execFileAsync(
    'psql',
    [ADMIN_DATABASE_URL, '-tAc', `SELECT 1 FROM pg_database WHERE datname = '${E2E_DATABASE_NAME}'`],
    { maxBuffer: 1024 * 1024 },
  );

  if (stdout.trim() !== '1') {
    await run('psql', [
      ADMIN_DATABASE_URL,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `CREATE DATABASE ${E2E_DATABASE_NAME}`,
    ]);
    process.stdout.write(`[e2e-env] created database ${E2E_DATABASE_NAME}\n`);
  }

  await run('npm', ['run', 'migrate'], { DATABASE_URL: E2E_DATABASE_URL, NODE_ENV: 'development' });
  await run('node', ['scripts/reset-e2e-db.mjs'], { DATABASE_URL: E2E_DATABASE_URL });
}

/* -------------------------------- lifecycle --------------------------------- */

let shuttingDown = false;

async function shutdown() {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  // Give the processes a moment to close their Redis and PostgreSQL connections so
  // this process exits cleanly instead of leaving aborted handles behind.
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

async function bail(error) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[e2e-env] ${error instanceof Error ? error.stack : String(error)}\n`);
  await shutdown();
  process.exit(1);
}

process.on('SIGTERM', () => void bail(new Error('received SIGTERM')));
process.on('SIGINT', () => void bail(new Error('received SIGINT')));

try {
  await prepareDatabase();
  await startSmtpSink();
  process.stdout.write(`[e2e-env] smtp sink listening on 127.0.0.1:${SMTP_PORT}\n`);

  // The provider contract server must be up before the API and worker start, because
  // both read their provider configuration from the environment at process start.
  spawnChild('stub', 'npx', ['tsx', 'tests/helpers/provider-stub-server.ts'], {
    PROVIDER_STUB_PORT: String(STUB_PORT),
  });
  await waitForPort(STUB_PORT, 'provider stub');

  const stackEnv = {
    NODE_ENV: 'development',
    DATABASE_URL: E2E_DATABASE_URL,
    APPLICATION_URL: WEB_ORIGIN,
    API_PORT: String(API_PORT),
    COOKIE_SECURE: 'false',
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'info',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_ROOT: 'storage-e2e',
    // A real SMTP delivery, captured on the wire by the sink above.
    EMAIL_DRIVER: 'smtp',
    EMAIL_FROM: 'Zyvano <no-reply@zyvano.test>',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(SMTP_PORT),
    SMTP_SECURE: 'false',
    WORKER_QUEUE_PREFIX: 'zyvano-e2e',
    OPENAI_API_KEY: 'e2e-key-openai',
    ELEVENLABS_API_KEY: 'e2e-key-elevenlabs',
    REPLICATE_API_TOKEN: 'e2e-token-replicate',
    OPENAI_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    ELEVENLABS_BASE_URL: `http://127.0.0.1:${STUB_PORT}/elevenlabs`,
    REPLICATE_BASE_URL: `http://127.0.0.1:${STUB_PORT}/replicate`,
    // Keep throughput limits out of the way of a browser-driven flow while leaving
    // them enabled; the limiter's own behaviour is asserted by the API suite.
    RATE_LIMIT_AUTH_MAX: '10000',
    RATE_LIMIT_API_MAX: '100000',
    RATE_LIMIT_GENERATION_MAX: '10000',
    MEDIA_PROCESSING_ENABLED: 'true',
  };

  spawnChild('api', 'npx', ['tsx', 'apps/api/src/index.ts'], stackEnv);
  await waitForHttp(`http://127.0.0.1:${API_PORT}/health`, 'the API');

  spawnChild('worker', 'npx', ['tsx', 'apps/worker/src/index.ts'], stackEnv);

  // Vite is invoked directly rather than through `npm run dev:web`, so the host and
  // port flags reach Vite instead of being swallowed by npm.
  spawnChild(
    'web',
    'npx',
    ['vite', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'],
    { VITE_DEV_API_URL: `http://127.0.0.1:${API_PORT}` },
    path.join(repoRoot, 'apps', 'web'),
  );
  await waitForHttp(WEB_ORIGIN, 'the web server');

  process.stdout.write(`[e2e-env] stack ready at ${WEB_ORIGIN}\n`);

  // Playwright owns the lifetime: it kills this process, and its children, when the
  // suite finishes. Keeping the event loop alive is all that remains to do.
  await new Promise(() => {});
} catch (error) {
  await bail(error);
}
