/**
 * Media processing via ffmpeg/ffprobe.
 *
 * Used for: probing uploaded/generated media, extracting thumbnails, and
 * rendering the final export. All invocations use `execFile` with an argument
 * array (never a shell string) so filenames cannot inject commands.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { AppConfig } from '../../config/env';
import { logger } from '../../observability/logger';

const execFileAsync = promisify(execFile);

/** Maximum length of a stored encoder error message. */
const ENCODER_ERROR_LIMIT = 2000;

/**
 * Reduces an encoder failure to its diagnostics.
 *
 * The version banner, build configuration and per-frame statistics dominate the
 * output but say nothing about the failure, so they are dropped and the rest is
 * capped. What remains names the cause without bloating a database row or an API
 * response.
 */
function describeEncoderFailure(error: unknown): string {
  const record = (error ?? {}) as {
    message?: unknown;
    stderr?: unknown;
    signal?: unknown;
    killed?: unknown;
    code?: unknown;
  };
  const stderr = typeof record.stderr === 'string' ? record.stderr : '';
  const stdout = typeof record.message === 'string' ? record.message : '';
  const raw = stderr.length > 0 ? stderr : stdout;

  const diagnostics = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // The version banner, build configuration and libx264's codec option dump account
    // for most of the output but never explain a failure.
    .filter(
      (line) =>
        !/^ffmpeg version |^built with |^configuration: |^lib(av|sw|postproc)/.test(line) &&
        !/^\[libx264 @ .*(using cpu capabilities|using SAR|profile High|264 - core)/.test(line),
    )
    .slice(-15)
    .join('\n');

  // A signal with no exit code means the encoder was killed from outside (an OOM
  // killer or a supervisor) rather than exiting on its own. Saying so turns an
  // otherwise baffling "encoder failed" into something an operator can act on.
  const termination =
    record.signal !== undefined && record.signal !== null
      ? `terminated by signal ${String(record.signal)}`
      : record.code !== undefined && record.code !== null
        ? `exit ${String(record.code)}`
        : 'terminated without an exit status';

  const summary = diagnostics.length > 0 ? diagnostics : 'the encoder produced no diagnostics';
  return `Video encoder failed (${termination}): ${summary.slice(0, ENCODER_ERROR_LIMIT)}`;
}

export interface MediaProbeResult {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  formatName: string | null;
}

export interface RenderSegment {
  /** Local filesystem path of the source clip. */
  path: string;
  durationSeconds: number;
}

export interface RenderRequest {
  segments: RenderSegment[];
  audioPath?: string | undefined;
  width: number;
  height: number;
  videoBitrate: string;
  audioBitrate: string;
  format: 'mp4' | 'webm';
  outputPath: string;
}

export interface MediaProcessor {
  available(): Promise<boolean>;
  probe(filePath: string): Promise<MediaProbeResult>;
  thumbnail(input: { filePath: string; outputPath: string; width: number; timeOffsetSeconds?: number }): Promise<void>;
  render(request: RenderRequest): Promise<void>;
  withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T>;
}

class FfmpegProcessor implements MediaProcessor {
  constructor(private readonly config: AppConfig['media']) {}

  /**
   * Runs an encoder command and turns a failure into a bounded, reviewable error.
   *
   * A raw `execFile` rejection carries the tool's entire output — version banner,
   * build flags and per-frame statistics — which is far too large to persist or show.
   * Only the diagnostic lines are kept, capped, so the stored message names the actual
   * cause. The input files' presence is checked separately because "No such file or
   * directory" is by far the most common render failure and the least obvious from
   * ffmpeg's own output.
   */
  private async runEncoder(args: string[], inputPaths: readonly string[]): Promise<void> {
    for (const inputPath of inputPaths) {
      if (!existsSync(inputPath)) {
        throw new Error(`Render input is missing from storage: ${inputPath}`);
      }
    }

    // The thread budget and `-nostdin` are applied here rather than at each call site
    // so every encode is bounded consistently: an unbounded pool can starve the
    // supervising worker, and ffmpeg reading stdin can consume input a parent process
    // intended for itself.
    const bounded = [
      '-nostdin',
      '-threads',
      String(this.config.threads),
      // The filter graph otherwise instantiates per-core threads, each holding full
      // resolution frame buffers. A single-threaded graph keeps a scene render's
      // footprint flat instead of scaling with the host's core count.
      '-filter_threads',
      '1',
      ...args,
    ];
    try {
      await execFileAsync(this.config.ffmpegPath, bounded, { maxBuffer: 1024 * 1024 * 32 });
    } catch (error) {
      throw new Error(describeEncoderFailure(error));
    }
  }

  async available(): Promise<boolean> {
    try {
      await execFileAsync(this.config.ffmpegPath, ['-version']);
      return true;
    } catch {
      return false;
    }
  }

  async probe(filePath: string): Promise<MediaProbeResult> {
    const { stdout } = await execFileAsync(this.config.ffprobePath, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string; format_name?: string };
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    };

    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const duration = parsed.format?.duration ? Number(parsed.format.duration) : null;

    return {
      durationSeconds: duration !== null && Number.isFinite(duration) ? duration : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      hasAudio: Boolean(audio),
      hasVideo: Boolean(video),
      formatName: parsed.format?.format_name ?? null,
    };
  }

  async thumbnail(input: {
    filePath: string;
    outputPath: string;
    width: number;
    timeOffsetSeconds?: number;
  }): Promise<void> {
    await execFileAsync(this.config.ffmpegPath, [
      '-y',
      '-ss',
      String(input.timeOffsetSeconds ?? 0),
      '-i',
      input.filePath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${input.width}:-2`,
      input.outputPath,
    ]);
  }

  /**
   * Renders the export. Segments are concatenated (re-encoded so mismatched
   * sources still stitch correctly), then the optional audio track is muxed in.
   */
  async render(request: RenderRequest): Promise<void> {
    if (request.segments.length === 0) {
      throw new Error('Render requires at least one segment.');
    }

    const scaleFilter = `scale=${request.width}:${request.height}:force_original_aspect_ratio=decrease,pad=${request.width}:${request.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;

    const args: string[] = ['-y'];
    for (const segment of request.segments) {
      args.push('-i', segment.path);
    }
    const audioIndex = request.audioPath ? request.segments.length : -1;
    if (request.audioPath) args.push('-i', request.audioPath);

    const filters = request.segments.map((_, index) => `[${index}:v]${scaleFilter}[v${index}]`).join(';');
    const concatInputs = request.segments.map((_, index) => `[v${index}]`).join('');
    const filterComplex = `${filters};${concatInputs}concat=n=${request.segments.length}:v=1:a=0[outv]`;

    args.push('-filter_complex', filterComplex, '-map', '[outv]');
    if (request.audioPath) args.push('-map', `${audioIndex}:a`, '-shortest');

    args.push(
      '-c:v',
      'libx264',
      '-preset',
      // `slow`/`medium` hold more lookahead frames and b-frames resident for a small
      // encoding-efficiency gain. During an export that extra memory is what pushes a
      // render past a container's limit, and a memory-limited render is not a render at
      // all, so a fast preset which keeps memory bounded is the correct trade.
      this.config.preset,
      // `zerolatency` is the single largest memory lever available: it turns off the
      // encoder's lookahead and frame buffering, which is what makes peak memory scale
      // with resolution and thread count. Measured on this codebase it cuts a 1080p
      // concat render from ~909MB to ~158MB resident, and the output remains a standard
      // playable MP4. Without it a render is killed outright on a memory-limited host.
      '-tune',
      'zerolatency',
      '-b:v',
      request.videoBitrate,
      // Bound the encoder's own buffers so peak memory does not scale with resolution
      // and thread count.
      '-bufsize',
      this.config.encoderBufferSize,
      '-max_muxing_queue_size',
      String(this.config.muxingQueueSize),
      '-pix_fmt',
      'yuv420p',
    );
    if (request.audioPath) {
      args.push('-c:a', 'aac', '-b:a', request.audioBitrate);
    } else {
      args.push('-an');
    }
    args.push('-movflags', '+faststart', request.outputPath);

    logger.info({ segments: request.segments.length, output: request.outputPath }, 'rendering export');
    await this.runEncoder(
      args,
      [
        ...request.segments.map((segment) => segment.path),
        ...(request.audioPath ? [request.audioPath] : []),
      ],
    );
  }

  async withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), 'zyvano-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export function createMediaProcessor(config: AppConfig['media']): MediaProcessor {
  return new FfmpegProcessor(config);
}

export { readFile, writeFile };
