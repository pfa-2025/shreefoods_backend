import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface StoredFile {
  /** Public URL the browser loads. */
  url: string;
  /** Provider-specific id used later to delete the file. */
  key: string;
}

export abstract class StorageProvider {
  abstract readonly name: 'local' | 'cloudinary';
  abstract save(data: Buffer, ext: 'jpg' | 'png' | 'webp', mime: string): Promise<StoredFile>;
  abstract remove(key: string): Promise<void>;
}

/** Local-disk storage for development. Files vanish when a host's disk is wiped, so production uses Cloudinary. */
export class LocalStorage extends StorageProvider {
  readonly name = 'local' as const;
  static readonly KEY_PATTERN = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

  constructor(readonly dir: string) {
    super();
  }

  async save(data: Buffer, ext: 'jpg' | 'png' | 'webp', _mime?: string): Promise<StoredFile> {
    await mkdir(this.dir, { recursive: true });
    const key = `${randomBytes(16).toString('hex')}.${ext}`; // never derived from the client's filename
    await writeFile(path.join(this.dir, key), data, { flag: 'wx' });
    return { key, url: `/api/v1/uploads/${key}` };
  }

  async remove(key: string): Promise<void> {
    if (!LocalStorage.KEY_PATTERN.test(key)) return; // refuse anything that isn't one of our own keys
    await rm(path.join(this.dir, key), { force: true });
  }
}

/** Cloudinary's documented signing rule: sha1 of the sorted "k=v" params joined by "&", plus the API secret. */
export function cloudinarySignature(params: Record<string, string | number>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(toSign + apiSecret).digest('hex');
}

/**
 * Cloudinary storage over its signed REST API (no SDK dependency).
 * NOTE: implemented to Cloudinary's documented API but NOT yet exercised against a live account.
 * Verify with real credentials before launch.
 */
export class CloudinaryStorage extends StorageProvider {
  readonly name = 'cloudinary' as const;
  constructor(
    private readonly cloud: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
  ) {
    super();
  }

  async save(data: Buffer, ext: string, mime: string): Promise<StoredFile> {
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = 'shreefoods';
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(data)], { type: mime }), `upload.${ext}`);
    form.set('api_key', this.apiKey);
    form.set('timestamp', String(timestamp));
    form.set('folder', folder);
    form.set('signature', cloudinarySignature({ folder, timestamp }, this.apiSecret));
    const res = await fetch(`https://api.cloudinary.com/v1_1/${this.cloud}/image/upload`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Cloudinary upload failed (${res.status})`);
    const body = (await res.json()) as { secure_url: string; public_id: string };
    return { url: body.secure_url, key: body.public_id };
  }

  async remove(key: string): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000);
    const form = new URLSearchParams({
      public_id: key,
      api_key: this.apiKey,
      timestamp: String(timestamp),
      signature: cloudinarySignature({ public_id: key, timestamp }, this.apiSecret),
    });
    const res = await fetch(`https://api.cloudinary.com/v1_1/${this.cloud}/image/destroy`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Cloudinary delete failed (${res.status})`);
  }
}
