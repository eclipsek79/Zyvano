import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface StoragePutInput {
  key: string;
  body: Buffer;
  contentType?: string;
  metadata?: Record<string, unknown>;
}

export interface StorageHead {
  size: number;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface StorageDeleteResult {
  deleted: number;
  failed: string[];
}

export interface StorageSignedUrlOptions {
  download?: boolean;
  downloadFilename?: string;
  expiresIn?: number;
}

export interface ObjectStorage {
  readonly driver: 'local' | 's3';
  readonly ok: boolean;
  readonly error?: string;

  put(input: StoragePutInput): Promise<void>;
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<StorageHead | null>;
  exists(key: string): Promise<boolean>;
  deleteMany(keys: string[]): Promise<StorageDeleteResult>;
  signedUrl(key: string, options?: StorageSignedUrlOptions): Promise<string>;
  localPath(key: string): Promise<string>;
}

export interface StorageConfig {
  driver: 'local' | 's3';
  localRoot: string;
  endpoint?: string;
  region: string;
  bucket: string;
  accessKey?: string;
  secretKey?: string;
  forcePathStyle: boolean;
}

function assertSafeKey(key: string): void {
  if (!key || key.includes('\0')) {
    throw new Error('Storage key must be a non-empty string without null bytes.');
  }

  const normalized = path.posix.normalize(key.replace(/\\/g, '/'));

  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.startsWith('/')
  ) {
    throw new Error('Storage key escapes the configured storage root.');
  }
}

function localPath(root: string, key: string): string {
  assertSafeKey(key);
  return path.join(root, ...key.replace(/\\/g, '/').split('/'));
}

function toS3Metadata(metadata?: Record<string, unknown>): Record<string, string> | undefined {
  if (!metadata) return undefined;

  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ]),
  );
}

class LocalObjectStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  readonly ok = true;
  readonly error = undefined;

  constructor(private readonly root: string) {}

  async put(input: StoragePutInput): Promise<void> {
    const destination = localPath(this.root, input.key);
    await mkdir(path.dirname(destination), { recursive: true });

    const temporary = `${destination}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;

    try {
      await writeFile(temporary, input.body);
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(localPath(this.root, key));
  }

  async head(key: string): Promise<StorageHead | null> {
    try {
      const info = await stat(localPath(this.root, key));

      if (!info.isFile()) return null;

      return {
        size: info.size,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async deleteMany(keys: string[]): Promise<StorageDeleteResult> {
    let deleted = 0;
    const failed: string[] = [];

    for (const key of keys) {
      try {
        await unlink(localPath(this.root, key));
        deleted += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }

        failed.push(key);
      }
    }

    return { deleted, failed };
  }

  async signedUrl(key: string, _options: StorageSignedUrlOptions = {}): Promise<string> {
    assertSafeKey(key);

    // Local storage has no independent HTTP origin. ExportService translates
    // this marker into its authenticated API streaming endpoint.
    return `local://${encodeURIComponent(key)}`;
  }

  async localPath(key: string): Promise<string> {
    return localPath(this.root, key);
  }
}

class S3ObjectStorage implements ObjectStorage {
  readonly driver = 's3' as const;
  readonly ok = true;
  readonly error = undefined;

  private readonly client: S3Client;

  constructor(private readonly config: StorageConfig) {
    if (!config.bucket) {
      throw new Error('S3 storage requires a bucket.');
    }

    if (!config.accessKey || !config.secretKey) {
      throw new Error('S3 storage requires access and secret credentials.');
    }

    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
  }

  async put(input: StoragePutInput): Promise<void> {
    assertSafeKey(input.key);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        Metadata: toS3Metadata(input.metadata),
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);

    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
    );

    if (!response.Body) {
      throw new Error(`Storage object has no response body: ${key}`);
    }

    return Buffer.from(await response.Body.transformToByteArray());
  }

  async head(key: string): Promise<StorageHead | null> {
    assertSafeKey(key);

    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        }),
      );

      return {
        size: response.ContentLength ?? 0,
        contentType: response.ContentType,
        metadata: response.Metadata,
      };
    } catch (error) {
      const statusCode = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      const name = (error as { name?: string }).name;

      if (statusCode === 404 || name === 'NotFound' || name === 'NoSuchKey') {
        return null;
      }

      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async deleteMany(keys: string[]): Promise<StorageDeleteResult> {
    const uniqueKeys = [...new Set(keys)];

    if (uniqueKeys.length === 0) {
      return { deleted: 0, failed: [] };
    }

    let deleted = 0;
    const failed: string[] = [];

    for (let index = 0; index < uniqueKeys.length; index += 1000) {
      const chunk = uniqueKeys.slice(index, index + 1000);

      chunk.forEach(assertSafeKey);

      try {
        const response = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.config.bucket,
            Delete: {
              Objects: chunk.map((Key) => ({ Key })),
              Quiet: false,
            },
          }),
        );

        deleted += response.Deleted?.length ?? 0;

        for (const failure of response.Errors ?? []) {
          if (failure.Key) failed.push(failure.Key);
        }
      } catch {
        failed.push(...chunk);
      }
    }

    return { deleted, failed };
  }

  async signedUrl(key: string, options: StorageSignedUrlOptions = {}): Promise<string> {
    assertSafeKey(key);

    const expiresIn = Math.min(Math.max(options.expiresIn ?? 900, 1), 604800);

    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ...(options.download && options.downloadFilename
          ? {
              ResponseContentDisposition: `attachment; filename="${options.downloadFilename.replace(/["\\]/g, '_')}"`,
            }
          : {}),
      }),
      { expiresIn },
    );
  }

  async localPath(_key: string): Promise<string> {
    throw new Error('localPath() is not available for the S3 storage driver.');
  }
}

export function createObjectStorage(config: StorageConfig): ObjectStorage {
  if (config.driver === 's3') {
    return new S3ObjectStorage(config);
  }

  if (config.driver === 'local') {
    return new LocalObjectStorage(config.localRoot);
  }

  throw new Error(`Unsupported storage driver: ${String(config.driver)}`);
}
