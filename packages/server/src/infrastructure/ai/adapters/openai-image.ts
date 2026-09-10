/**
 * OpenAI image adapter (images/generations, b64_json response).
 */
import type { ImageGenerationRequest, ImageProvider, MediaOutput, ProviderResult } from '../interfaces';
import { ProviderInvocationError } from '../interfaces';
import { providerUnavailableError } from '../errors';
import { fetchJson } from '../http';
import type { OpenAIConfig } from './openai-text';

interface ImageResponse {
  created?: number;
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
}

export class OpenAIImageProvider implements ImageProvider {
  readonly id = 'openai';
  readonly capability = 'image' as const;

  constructor(private readonly config: OpenAIConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  missingEnv(): readonly string[] {
    return this.isConfigured() ? [] : ['OPENAI_API_KEY'];
  }

  async generate(request: ImageGenerationRequest): Promise<ProviderResult<MediaOutput>> {
    if (!this.isConfigured()) {
      throw providerUnavailableError(this.id, 'image', this.missingEnv());
    }

    const model = request.model ?? 'gpt-image-1';
    const started = Date.now();

    const size = this.resolveSize(request.width, request.height);
    const { data, externalRequestId } = await fetchJson<ImageResponse>(
      `${this.config.baseUrl}/images/generations`,
      {
        method: 'POST',
        provider: this.id,
        timeoutMs: this.config.timeoutMs,
        expect: 'json',
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        body: { model, prompt: request.prompt, size, n: 1 },
      },
    );

    const first = data.data?.[0];
    if (!first?.b64_json) {
      throw new ProviderInvocationError(this.id, 'Provider returned no image payload.', {
        errorCode: 'EMPTY_IMAGE',
        retryable: true,
      });
    }

    const [width, height] = size.split('x').map(Number) as [number, number];
    return {
      data: {
        data: Buffer.from(first.b64_json, 'base64'),
        mimeType: 'image/png',
        extension: 'png',
        width,
        height,
      },
      meta: {
        provider: this.id,
        model,
        externalRequestId,
        latencyMs: Date.now() - started,
        usage: { units: 1, unitLabel: 'images', credits: 20 },
      },
    };
  }

  private resolveSize(width?: number, height?: number): string {
    const allowed = ['1024x1024', '1536x1024', '1024x1536'];
    const candidate = `${width ?? 1024}x${height ?? 1024}`;
    return allowed.includes(candidate) ? candidate : '1024x1024';
  }
}
