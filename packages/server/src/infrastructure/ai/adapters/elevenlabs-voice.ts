/**
 * ElevenLabs voice adapter (text-to-speech, binary mp3 response).
 */
import type { MediaOutput, ProviderResult, VoiceGenerationRequest, VoiceProvider } from '../interfaces';
import { providerUnavailableError } from '../errors';
import { fetchBinary } from '../http';

export interface ElevenLabsConfig {
  apiKey?: string | undefined;
  baseUrl: string;
  timeoutMs: number;
  defaultVoiceId?: string;
}

export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly id = 'elevenlabs';
  readonly capability = 'voice' as const;

  constructor(private readonly config: ElevenLabsConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  missingEnv(): readonly string[] {
    return this.isConfigured() ? [] : ['ELEVENLABS_API_KEY'];
  }

  async generate(request: VoiceGenerationRequest): Promise<ProviderResult<MediaOutput>> {
    if (!this.isConfigured()) {
      throw providerUnavailableError(this.id, 'voice', this.missingEnv());
    }

    const model = request.model ?? 'eleven_multilingual_v2';
    const voiceId = request.voiceId ?? this.config.defaultVoiceId ?? '21m00Tcm4TlvDq8ikWAM';
    const started = Date.now();

    const media = await fetchBinary(`${this.config.baseUrl}/text-to-speech/${voiceId}`, {
      method: 'POST',
      provider: this.id,
      timeoutMs: this.config.timeoutMs,
      expect: 'binary',
      headers: {
        'xi-api-key': this.config.apiKey as string,
        accept: 'audio/mpeg',
      },
      body: { text: request.text, model_id: model },
    });

    // Rough duration estimate (~15 characters per second) for the credits ledger;
    // the ProcessMedia job replaces it with the real value from ffprobe.
    const estimatedSeconds = Math.max(1, Math.round(request.text.length / 15));

    return {
      data: {
        data: media.data,
        mimeType: 'audio/mpeg',
        extension: 'mp3',
        durationSeconds: estimatedSeconds,
      },
      meta: {
        provider: this.id,
        model,
        externalRequestId: null,
        latencyMs: Date.now() - started,
        usage: {
          units: request.text.length,
          unitLabel: 'characters',
          credits: Math.max(1, Math.ceil(request.text.length / 1000)),
        },
      },
    };
  }
}
