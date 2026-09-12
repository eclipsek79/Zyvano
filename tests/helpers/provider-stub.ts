/**
 * Local AI-provider contract server.
 *
 * Zyvano's adapters (`packages/server/src/infrastructure/ai/adapters/*`) speak the
 * published wire protocols of OpenAI, ElevenLabs and Replicate, and all three base
 * URLs are configuration (`OPENAI_BASE_URL`, `ELEVENLABS_BASE_URL`,
 * `REPLICATE_BASE_URL`). This module runs a real HTTP server that answers those
 * exact protocols so the integration suite can drive the genuine adapter code —
 * real sockets, real JSON parsing, real base64 decoding, real binary streaming —
 * without any external credentials.
 *
 * This is a contract double for a third-party API, not a mock of Zyvano. No
 * application module is stubbed: the adapters, the worker handlers, the
 * repositories and the database are all the production implementations, and every
 * row the tests assert on is written by that production code after a genuine
 * adapter round-trip. Media fixtures are real encodings produced by ffmpeg, so the
 * render path probes and concatenates authentic files.
 *
 * The listener binds an ephemeral port so concurrent test files can never collide;
 * `applyStubEnvironment` publishes the resolved URLs into `process.env`.
 */
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let origin = '';

/** Base origin of the running stub. Empty until `startProviderStub` resolves. */
export function stubOrigin(): string {
  return origin;
}

const SCRIPT_TEXT = [
  'City at First Light',
  '',
  '1. Before the traffic, a single cart rolls into the square.',
  '2. Steam rises; the first cup of the day is poured.',
  '3. The doors open and the day begins.',
].join('\n');

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

/**
 * A failure the stub should return for matching requests.
 *
 * `remaining` is decremented per match, which lets a test assert both the failure
 * and the subsequent recovery of the same operation.
 */
export interface FailureRule {
  pathIncludes: string;
  remaining: number;
  status: number;
  body: string;
  /** Hold the response open this long before answering (drives the timeout path). */
  delayMs?: number;
}

interface StubState {
  calls: RecordedCall[];
  failures: FailureRule[];
  /** Plain path-includes delays, applied without failing the request. */
  delays: Array<{ pathIncludes: string; ms: number }>;
  scriptText: string;
  shotCount: number;
}

const state: StubState = {
  calls: [],
  failures: [],
  delays: [],
  scriptText: SCRIPT_TEXT,
  shotCount: 4,
};

/* ------------------------------- media fixtures ----------------------------- */

let mp4: Buffer | null = null;
let png: Buffer | null = null;
let mp3: Buffer | null = null;

/** Renders one media fixture with the real encoder and returns its bytes. */
async function renderFixture(extension: string, args: string[]): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyvano-fixture-'));
  const output = path.join(dir, `fixture.${extension}`);
  try {
    await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args, output], {
      maxBuffer: 1024 * 1024 * 64,
    });
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A real 2-second H.264/AAC clip, used as the video provider's artifact. */
export async function mp4Fixture(): Promise<Buffer> {
  if (!mp4) {
    mp4 = await renderFixture('mp4', [
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x480:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'aac',
      '-shortest',
    ]);
  }
  return mp4;
}

/** A real PNG, used as the image provider's artifact. */
export async function pngFixture(): Promise<Buffer> {
  if (!png) {
    png = await renderFixture('png', [
      '-f', 'lavfi', '-i', 'color=c=steelblue:s=1024x1024:d=1',
      '-frames:v', '1',
    ]);
  }
  return png;
}

/** A real MP3, used as the voice provider's artifact. */
export async function mp3Fixture(): Promise<Buffer> {
  if (!mp3) {
    mp3 = await renderFixture('mp3', [
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:a', 'libmp3lame',
    ]);
  }
  return mp3;
}

/* -------------------------------- request I/O ------------------------------- */

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
    'x-request-id': 'stub-request',
  });
  res.end(body);
}

function sendBytes(res: ServerResponse, status: number, bytes: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(bytes.byteLength) });
  res.end(bytes);
}

/** Finds the first failure rule that matches this path and still has attempts left. */
function takeFailure(pathname: string): FailureRule | null {
  for (const rule of state.failures) {
    if (rule.remaining <= 0) continue;
    if (!pathname.includes(rule.pathIncludes)) continue;
    rule.remaining -= 1;
    return rule;
  }
  return null;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  const raw = await readBody(req);

  let parsedBody: unknown = null;
  if (raw.byteLength > 0) {
    try {
      parsedBody = JSON.parse(raw.toString('utf8'));
    } catch {
      parsedBody = raw.toString('utf8');
    }
  }
  state.calls.push({ method: req.method ?? 'GET', path: pathname, body: parsedBody });

  const failure = takeFailure(pathname);
  if (failure) {
    if (failure.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, failure.delayMs));
    }
    res.writeHead(failure.status, {
      'content-type': 'application/json',
      'x-request-id': 'stub-failure',
    });
    res.end(failure.body);
    return;
  }

  // A plain delay makes a state transition observable without changing the outcome,
  // which is how the `processing` phase is sampled rather than raced.
  for (const delay of state.delays) {
    if (pathname.includes(delay.pathIncludes)) {
      await new Promise((resolve) => setTimeout(resolve, delay.ms));
      break;
    }
  }

  /* --------------------------- OpenAI: chat completions -------------------------- */
  if (pathname.endsWith('/chat/completions')) {
    const body = (parsedBody ?? {}) as { response_format?: unknown };
    // A structured request (storyboard) must receive parseable JSON; the adapter
    // rejects anything else, which is exactly the behaviour under test.
    const content =
      body.response_format !== undefined
        ? JSON.stringify({
            shots: Array.from({ length: state.shotCount }, (_, index) => ({
              sceneNumber: index + 1,
              description: `Shot ${index + 1}: a wide exterior at golden hour, slow push in.`,
              cameraAngle: 'wide',
              durationSeconds: 3,
            })),
          })
        : state.scriptText;

    sendJson(res, 200, {
      id: 'chatcmpl-stub-1',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 340, total_tokens: 460 },
    });
    return;
  }

  /* --------------------------- OpenAI: image generation -------------------------- */
  if (pathname.endsWith('/images/generations')) {
    const bytes = await pngFixture();
    sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: bytes.toString('base64') }],
    });
    return;
  }

  /* ------------------------------ ElevenLabs: TTS -------------------------------- */
  if (pathname.includes('/text-to-speech/')) {
    sendBytes(res, 200, await mp3Fixture(), 'audio/mpeg');
    return;
  }

  /* --------------------- Replicate: create + fetch artifact ---------------------- */
  if (pathname.includes('/predictions')) {
    // Terminal status on creation: the adapter's poll loop would otherwise wait
    // 3 seconds between attempts and slow the suite down for no added coverage.
    sendJson(res, 200, {
      id: 'pred-stub-1',
      status: 'succeeded',
      output: [`${origin}/replicate/files/clip.mp4`],
      urls: { get: `${origin}/replicate/predictions/pred-stub-1` },
    });
    return;
  }

  if (pathname === '/replicate/files/clip.mp4') {
    sendBytes(res, 200, await mp4Fixture(), 'video/mp4');
    return;
  }

  sendJson(res, 404, { error: { message: `The stub has no route for ${pathname}` } });
}

/* --------------------------------- lifecycle -------------------------------- */

let server: Server | null = null;

/** Starts the contract server. Binds `port` when given, else an ephemeral port. */
export async function startProviderStub(port = 0): Promise<string> {
  if (server && origin) return origin;

  server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(
        JSON.stringify({
          error: { message: error instanceof Error ? error.message : 'stub failure' },
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(port, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('The provider stub failed to bind a TCP port.');
  }
  origin = `http://127.0.0.1:${address.port}`;
  return origin;
}

/**
 * Stops the server and releases the port.
 *
 * Idle keep-alive sockets (the adapter's fetch pool) would otherwise hold the
 * listener open and hang the test process, so established connections are closed
 * explicitly before the listener.
 */
export async function stopProviderStub(): Promise<void> {
  if (!server) return;
  const closing = server;
  server = null;
  closing.closeIdleConnections();
  await new Promise<void>((resolve) => closing.close(() => resolve()));
}

/**
 * Publishes the stub's URLs and placeholder keys into the environment.
 *
 * Must run before anything imports `@zyvano/server/config/env`, because that module
 * validates and memoizes the configuration at import time. `tests/setup.ts` calls
 * this before the test files are loaded, so the adapters under test are the real
 * ones pointed at the contract server.
 */
export async function applyStubEnvironment(): Promise<void> {
  const base = await startProviderStub();
  process.env.OPENAI_BASE_URL = `${base}/v1`;
  process.env.ELEVENLABS_BASE_URL = `${base}/elevenlabs`;
  process.env.REPLICATE_BASE_URL = `${base}/replicate`;
  // Placeholder credentials: the adapters require a truthy key to consider
  // themselves configured, and the stub ignores the value. No real secret is used.
  process.env.OPENAI_API_KEY = 'test-key-openai';
  process.env.ELEVENLABS_API_KEY = 'test-key-elevenlabs';
  process.env.REPLICATE_API_TOKEN = 'test-token-replicate';
}

export const providerStub = {
  /** Every request the adapters made, in order. */
  calls: (): RecordedCall[] => state.calls,
  /** Requests whose path contains the given fragment. */
  callsMatching: (fragment: string): RecordedCall[] =>
    state.calls.filter((call) => call.path.includes(fragment)),

  /**
   * Schedules a failure for matching requests. `times` counts down, so a rule with
   * `times: 1` fails the next request and lets the following one succeed.
   */
  injectFailure(rule: {
    pathIncludes: string;
    times?: number;
    status?: number;
    body?: string;
    delayMs?: number;
  }): void {
    state.failures.push({
      pathIncludes: rule.pathIncludes,
      remaining: rule.times ?? 1,
      status: rule.status ?? 500,
      body: rule.body ?? JSON.stringify({ error: { message: 'stub provider failure' } }),
      ...(rule.delayMs !== undefined ? { delayMs: rule.delayMs } : {}),
    });
  },

  /**
   * Adds latency to matching requests without changing their outcome.
   *
   * Used to make a fast transition (queued -> processing -> completed) long enough
   * to sample in its intermediate state. `reset()` clears these.
   */
  injectDelay(rule: { pathIncludes: string; ms?: number }): void {
    state.delays.push({ pathIncludes: rule.pathIncludes, ms: rule.ms ?? 750 });
  },

  /** Clears all failure injection, added latency, and the recorded call log. */
  reset(): void {
    state.failures = [];
    state.delays = [];
    state.calls = [];
  },

  /** Overrides the script text returned for a plain completion. */
  setScriptText(text: string): void {
    state.scriptText = text;
  },

  /** Number of shots the storyboard completion returns. */
  setShotCount(count: number): void {
    state.shotCount = count;
  },
};
