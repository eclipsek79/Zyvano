/**
 * AI provider abstraction.
 *
 * Zyvano never talks to a vendor SDK directly. Services depend on the interfaces
 * below, and adapters implement them. Adding a provider means writing one adapter
 * and registering it — no service code changes.
 *
 * Every adapter declares whether it is `configured`. An unconfigured adapter
 * throws `PROVIDER_NOT_CONFIGURED` rather than returning fabricated output.
 */
import type { AICapability, ProviderDescriptor } from '@zyvano/shared';

export interface ProviderUsage {
  /** Provider-reported token/character/second count, when available. */
  units: number;
  /** Normalized unit label for display (tokens, characters, seconds, images). */
  unitLabel: string;
  /** Credits debited from the organization quota. */
  credits: number;
}

export interface ProviderCallMeta {
  provider: string;
  model: string | null;
  externalRequestId: string | null;
  latencyMs: number;
  usage: ProviderUsage;
}

export interface ProviderResult<T> {
  data: T;
  meta: ProviderCallMeta;
}

/** Raised when the deployment lacks the credentials a provider needs. */
export class ProviderNotConfiguredError extends Error {
  constructor(
    readonly provider: string,
    readonly capability: AICapability,
    readonly missingEnv: readonly string[],
  ) {
    super(
      `Provider "${provider}" is not configured for ${capability}. Missing: ${missingEnv.join(', ')}`,
    );
    this.name = 'ProviderNotConfiguredError';
  }
}

/** Raised for transport/HTTP/provider-side failures. Always retryable-aware. */
export class ProviderInvocationError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly options: {
      httpStatus?: number;
      errorCode?: string;
      retryable?: boolean;
      externalRequestId?: string | null;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderInvocationError';
  }
}

/* --------------------------------- text ---------------------------------- */

export interface TextGenerationRequest {
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  model?: string;
  /** JSON schema the model must satisfy, when structured output is required. */
  jsonSchema?: Record<string, unknown>;
}

export interface TextGenerationResponse {
  text: string;
  /** Parsed JSON when `jsonSchema` was supplied and the model complied. */
  parsed?: unknown;
  finishReason: string | null;
}

export interface TextProvider {
  readonly id: string;
  readonly capability: 'text';
  isConfigured(): boolean;
  missingEnv(): readonly string[];
  generate(request: TextGenerationRequest): Promise<ProviderResult<TextGenerationResponse>>;
}

/* --------------------------------- image ---------------------------------- */

export interface ImageGenerationRequest {
  prompt: string;
  width?: number;
  height?: number;
  model?: string;
}

export interface MediaOutput {
  /** Raw bytes, streamed straight into object storage. */
  data: Buffer;
  mimeType: string;
  extension: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export interface ImageProvider {
  readonly id: string;
  readonly capability: 'image';
  isConfigured(): boolean;
  missingEnv(): readonly string[];
  generate(request: ImageGenerationRequest): Promise<ProviderResult<MediaOutput>>;
}

/* --------------------------------- video ---------------------------------- */

export interface VideoGenerationRequest {
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: string;
  /** First-frame reference image (already fetched and inlined as a data URL). */
  referenceImage?: { data: Buffer; mimeType: string };
  model?: string;
}

export interface VideoProvider {
  readonly id: string;
  readonly capability: 'video';
  isConfigured(): boolean;
  missingEnv(): readonly string[];
  generate(request: VideoGenerationRequest): Promise<ProviderResult<MediaOutput>>;
}

/* --------------------------------- audio ---------------------------------- */

export interface VoiceGenerationRequest {
  text: string;
  voiceId?: string;
  language?: string;
  model?: string;
}

export interface VoiceProvider {
  readonly id: string;
  readonly capability: 'voice';
  isConfigured(): boolean;
  missingEnv(): readonly string[];
  generate(request: VoiceGenerationRequest): Promise<ProviderResult<MediaOutput>>;
}

export interface AudioProvider {
  readonly id: string;
  readonly capability: 'audio';
  isConfigured(): boolean;
  missingEnv(): readonly string[];
  generate(request: VoiceGenerationRequest): Promise<ProviderResult<MediaOutput>>;
}

/** Anything a registry can hold. */
export type AnyProvider =
  | TextProvider
  | ImageProvider
  | VideoProvider
  | VoiceProvider
  | AudioProvider;

export type { ProviderDescriptor };
