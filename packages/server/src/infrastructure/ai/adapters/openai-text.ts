/**
 * OpenAI text adapter (chat completions).
 *
 * Configured only when OPENAI_API_KEY is present. Without it the adapter reports
 * itself unconfigured so the platform surfaces a clear configuration error
 * instead of inventing script content.
 */
import type {
  ProviderResult,
  TextGenerationRequest,
  TextGenerationResponse,
  TextProvider,
} from '../interfaces';
import { ProviderInvocationError } from '../interfaces';
import { providerUnavailableError } from '../errors';
import { fetchJson } from '../http';

export interface OpenAIConfig {
  apiKey?: string | undefined;
  baseUrl: string;
  textModel: string;
  timeoutMs: number;
}

interface ChatCompletionResponse {
  id?: string;
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class OpenAITextProvider implements TextProvider {
  readonly id = 'openai';
  readonly capability = 'text' as const;

  constructor(private readonly config: OpenAIConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  missingEnv(): readonly string[] {
    return this.isConfigured() ? [] : ['OPENAI_API_KEY'];
  }

  async generate(request: TextGenerationRequest): Promise<ProviderResult<TextGenerationResponse>> {
    if (!this.isConfigured()) {
      throw providerUnavailableError(this.id, 'text', this.missingEnv());
    }

    const model = request.model ?? this.config.textModel;
    const started = Date.now();

    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(request.system ? [{ role: 'system', content: request.system }] : []),
        { role: 'user', content: request.prompt },
      ],
      max_tokens: request.maxOutputTokens ?? 2048,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.jsonSchema) {
      body.response_format = { type: 'json_object' };
    }

    const { data, externalRequestId } = await fetchJson<ChatCompletionResponse>(
      `${this.config.baseUrl}/chat/completions`,
      {
        method: 'POST',
        provider: this.id,
        timeoutMs: this.config.timeoutMs,
        expect: 'json',
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        body,
      },
    );

    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text) {
      throw new ProviderInvocationError(this.id, 'Provider returned an empty completion.', {
        errorCode: 'EMPTY_COMPLETION',
        retryable: true,
      });
    }

    let parsed: unknown;
    if (request.jsonSchema) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ProviderInvocationError(
          this.id,
          'Provider did not return valid JSON for a structured request.',
          { errorCode: 'INVALID_JSON', retryable: true },
        );
      }
    }

    const tokens = data.usage?.total_tokens ?? 0;
    return {
      data: {
        text,
        ...(parsed !== undefined ? { parsed } : {}),
        finishReason: data.choices?.[0]?.finish_reason ?? null,
      },
      meta: {
        provider: this.id,
        model,
        externalRequestId: data.id ?? externalRequestId,
        latencyMs: Date.now() - started,
        usage: {
          units: tokens,
          unitLabel: 'tokens',
          // 1 credit per 1000 tokens, minimum 1 credit for a metered call.
          credits: Math.max(1, Math.ceil(tokens / 1000)),
        },
      },
    };
  }
}
