/**
 * Replicate video adapter.
 *
 * Replicate renders asynchronously: we create a prediction, then poll it until it
 * succeeds, then download the produced artifact. Polling is bounded by the
 * configured request timeout so a stuck prediction cannot hold a worker slot
 * forever — the worker's own retry/backoff then takes over.
 */
import type { MediaOutput, ProviderResult, VideoGenerationRequest, VideoProvider } from '../interfaces';
import { ProviderInvocationError } from '../interfaces';
import { providerUnavailableError } from '../errors';
import { fetchBinary, fetchJson } from '../http';

export interface ReplicateConfig {
  apiToken?: string | undefined;
  baseUrl: string;
  timeoutMs: number;
  /** Model version/ref used for text-to-video and image-to-video. */
  videoModel?: string;
}

interface Prediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: string | null;
  urls?: { get?: string };
}

export class ReplicateVideoProvider implements VideoProvider {
  readonly id = 'replicate';
  readonly capability = 'video' as const;

  constructor(private readonly config: ReplicateConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiToken);
  }

  missingEnv(): readonly string[] {
    return this.isConfigured() ? [] : ['REPLICATE_API_TOKEN'];
  }

  async generate(request: VideoGenerationRequest): Promise<ProviderResult<MediaOutput>> {
    if (!this.isConfigured()) {
      throw providerUnavailableError(this.id, 'video', this.missingEnv());
    }

    const model = request.model ?? this.config.videoModel ?? 'wan-video/wan-2.5-t2v-fast';
    const started = Date.now();
    const headers = {
      authorization: `Bearer ${this.config.apiToken}`,
      prefer: 'wait',
    };

    const input: Record<string, unknown> = {
      prompt: request.prompt,
    };
    if (request.durationSeconds) input.duration = request.durationSeconds;
    if (request.aspectRatio) input.aspect_ratio = request.aspectRatio;
    if (request.referenceImage) {
      input.image = `data:${request.referenceImage.mimeType};base64,${request.referenceImage.data.toString('base64')}`;
    }

    const created = await fetchJson<Prediction>(`${this.config.baseUrl}/models/${model}/predictions`, {
      method: 'POST',
      provider: this.id,
      timeoutMs: this.config.timeoutMs,
      expect: 'json',
      headers,
      body: { input },
    });

    let prediction = created.data;
    const deadline = Date.now() + this.config.timeoutMs;

    while (
      prediction.status !== 'succeeded' &&
      prediction.status !== 'failed' &&
      prediction.status !== 'canceled'
    ) {
      if (Date.now() > deadline) {
        throw new ProviderInvocationError(
          this.id,
          `Render did not finish within ${this.config.timeoutMs}ms.`,
          { errorCode: 'TIMEOUT', retryable: true, externalRequestId: prediction.id ?? null },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const polled = await fetchJson<Prediction>(
        prediction.urls?.get ?? `${this.config.baseUrl}/predictions/${prediction.id}`,
        {
          method: 'GET',
          provider: this.id,
          timeoutMs: this.config.timeoutMs,
          expect: 'json',
          headers,
        },
      );
      prediction = polled.data;
    }

    if (prediction.status !== 'succeeded') {
      throw new ProviderInvocationError(
        this.id,
        prediction.error ?? `Render ended with status ${prediction.status}.`,
        { errorCode: 'RENDER_FAILED', retryable: true, externalRequestId: prediction.id ?? null },
      );
    }

    const outputUrl = this.extractOutputUrl(prediction.output);
    if (!outputUrl) {
      throw new ProviderInvocationError(this.id, 'Render succeeded but returned no output URL.', {
        errorCode: 'MISSING_OUTPUT',
        retryable: true,
        externalRequestId: prediction.id ?? null,
      });
    }

    const media = await fetchBinary(outputUrl, {
      method: 'GET',
      provider: this.id,
      timeoutMs: this.config.timeoutMs,
      expect: 'binary',
    });

    return {
      data: {
        data: media.data,
        mimeType: media.mimeType.startsWith('video/') ? media.mimeType : 'video/mp4',
        extension: 'mp4',
        durationSeconds: request.durationSeconds,
      },
      meta: {
        provider: this.id,
        model,
        externalRequestId: prediction.id ?? null,
        latencyMs: Date.now() - started,
        usage: {
          units: request.durationSeconds ?? 5,
          unitLabel: 'seconds',
          credits: 120,
        },
      },
    };
  }

  private extractOutputUrl(output: unknown): string | null {
    if (typeof output === 'string') return output;
    if (Array.isArray(output)) {
      const first = output.find((item) => typeof item === 'string');
      return typeof first === 'string' ? first : null;
    }
    if (output && typeof output === 'object') {
      const record = output as Record<string, unknown>;
      for (const key of ['video', 'url', 'output']) {
        const value = record[key];
        if (typeof value === 'string') return value;
      }
    }
    return null;
  }
}
