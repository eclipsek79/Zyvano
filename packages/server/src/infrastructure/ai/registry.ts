/**
 * Provider registry.
 *
 * Owns adapter construction and selection. Services ask the registry for a
 * provider by capability and an optional explicit provider id; the registry
 * resolves the default from configuration.
 */
import type { AICapability, ProviderDescriptor } from '@zyvano/shared';

import type { AppConfig } from '../../config/env';
import { providerUnavailableError } from './errors';
import { ElevenLabsVoiceProvider } from './adapters/elevenlabs-voice';
import { OpenAIImageProvider } from './adapters/openai-image';
import { OpenAITextProvider } from './adapters/openai-text';
import { ReplicateVideoProvider } from './adapters/replicate-video';
import type {
  AnyProvider,
  AudioProvider,
  ImageProvider,
  TextProvider,
  VideoProvider,
  VoiceProvider,
} from './interfaces';

export interface ProviderRegistry {
  /** All registered adapters with their configuration state. */
  describe(): ProviderDescriptor[];
  text(providerId?: string): TextProvider;
  image(providerId?: string): ImageProvider;
  video(providerId?: string): VideoProvider;
  voice(providerId?: string): VoiceProvider;
  audio(providerId?: string): AudioProvider;
  /** Default provider id for a capability, from configuration. */
  defaultProviderFor(capability: AICapability): string;
}

export function createProviderRegistry(ai: AppConfig['ai']): ProviderRegistry {
  const openai = () =>
    new OpenAITextProvider({
      apiKey: ai.openai.apiKey,
      baseUrl: ai.openai.baseUrl,
      textModel: ai.openai.textModel,
      timeoutMs: ai.requestTimeoutMs,
    });

  const openaiImage = () =>
    new OpenAIImageProvider({
      apiKey: ai.openai.apiKey,
      baseUrl: ai.openai.baseUrl,
      textModel: ai.openai.textModel,
      timeoutMs: ai.requestTimeoutMs,
    });

  const replicate = () =>
    new ReplicateVideoProvider({
      apiToken: ai.replicate.apiToken,
      baseUrl: ai.replicate.baseUrl,
      timeoutMs: ai.requestTimeoutMs,
    });

  const elevenlabs = () =>
    new ElevenLabsVoiceProvider({
      apiKey: ai.elevenlabs.apiKey,
      baseUrl: ai.elevenlabs.baseUrl,
      timeoutMs: ai.requestTimeoutMs,
    });

  const adapters: Record<AICapability, () => AnyProvider> = {
    text: openai,
    image: openaiImage,
    video: replicate,
    audio: elevenlabs,
    voice: elevenlabs,
  };

  /**
   * Resolves an adapter for a capability. Today exactly one adapter exists per
   * capability; requesting a provider id we have no adapter for is a
   * configuration error, never a silent fallback to a different vendor.
   */
  function resolve<T extends AnyProvider>(capability: AICapability, providerId?: string): T {
    const requested = providerId ?? ai.defaults[capability];
    const provider = adapters[capability]();

    if (requested !== provider.id) {
      throw providerUnavailableError(requested, capability, [`AI_PROVIDER_ADAPTER(${requested})`]);
    }
    return provider as T;
  }

  return {
    describe(): ProviderDescriptor[] {
      const capabilities: AICapability[] = ['text', 'image', 'video', 'audio', 'voice'];
      return capabilities.map((capability) => {
        const provider = adapters[capability]();
        return {
          id: provider.id,
          label: provider.id === 'openai' ? 'OpenAI' : provider.id === 'replicate' ? 'Replicate' : 'ElevenLabs',
          capabilities: [capability],
          configured: provider.isConfigured(),
          requiredEnv: provider.missingEnv(),
        };
      });
    },
    text: (providerId?: string) => resolve<TextProvider>('text', providerId),
    image: (providerId?: string) => resolve<ImageProvider>('image', providerId),
    video: (providerId?: string) => resolve<VideoProvider>('video', providerId),
    voice: (providerId?: string) => resolve<VoiceProvider>('voice', providerId),
    audio: (providerId?: string) => resolve<AudioProvider>('audio', providerId),
    defaultProviderFor: (capability: AICapability) => ai.defaults[capability],
  };
}
