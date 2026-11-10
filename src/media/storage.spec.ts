import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalStorage, R2Storage, cloudinarySignature } from './storage';

describe('cloudinarySignature', () => {
  it('signs sorted params followed by the secret', () => {
    const expected = createHash('sha1').update('folder=shreefoods&timestamp=1700000000' + 'secret').digest('hex');
    expect(cloudinarySignature({ timestamp: 1700000000, folder: 'shreefoods' }, 'secret')).toBe(expected);
  });
  it('changes with the secret', () => {
    expect(cloudinarySignature({ a: 1 }, 'one')).not.toBe(cloudinarySignature({ a: 1 }, 'two'));
  });
});

describe('LocalStorage', () => {
  let dir: string;
  beforeAll(async () => (dir = await mkdtemp(path.join(tmpdir(), 'sf-media-'))));
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('stores under a random key and removes it again', async () => {
    const s = new LocalStorage(dir);
    const f = await s.save(Buffer.from('data'), 'png', 'image/png');
    expect(f.key).toMatch(LocalStorage.KEY_PATTERN);
    expect(f.url).toBe(`/api/v1/uploads/${f.key}`);
    expect((await readFile(path.join(dir, f.key))).toString()).toBe('data');
    await s.remove(f.key);
    await expect(stat(path.join(dir, f.key))).rejects.toThrow();
  });
  it('refuses to delete anything that is not one of its own keys (path traversal)', async () => {
    const s = new LocalStorage(dir);
    const outside = path.join(dir, '..', 'sf-should-survive.txt');
    await import('node:fs/promises').then((fs) => fs.writeFile(outside, 'x'));
    await s.remove('../sf-should-survive.txt');
    expect((await readFile(outside)).toString()).toBe('x');
    await rm(outside);
  });
});

describe('R2Storage', () => {
  const cfg = { endpoint: 'https://acct.r2.cloudflarestorage.com', accessKeyId: 'id', secretAccessKey: 'secret', bucket: 'shree', publicUrl: 'https://pub-abc.r2.dev/' };
  const fake = () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const client = { send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => void sent.push({ name: cmd.constructor.name, input: cmd.input }) };
    return { sent, storage: new R2Storage(cfg, client as never) };
  };

  it('uploads under a random key with the right type and a long cache life, and returns the public URL', async () => {
    const { sent, storage } = fake();
    const f = await storage.save(Buffer.from('data'), 'webp', 'image/webp');
    expect(f.key).toMatch(R2Storage.KEY_PATTERN);
    expect(f.url).toBe(`https://pub-abc.r2.dev/${f.key}`); // no double slash even if the base URL ends in one
    expect(sent[0].name).toBe('PutObjectCommand');
    expect(sent[0].input).toMatchObject({ Bucket: 'shree', Key: f.key, ContentType: 'image/webp' });
    expect(String(sent[0].input.CacheControl)).toContain('immutable');
  });
  it('deletes its own keys', async () => {
    const { sent, storage } = fake();
    await storage.remove('shreefoods/0123456789abcdef0123456789abcdef.png');
    expect(sent[0]).toMatchObject({ name: 'DeleteObjectCommand', input: { Bucket: 'shree', Key: 'shreefoods/0123456789abcdef0123456789abcdef.png' } });
  });
  it('refuses to delete anything that is not one of its own keys', async () => {
    const { sent, storage } = fake();
    for (const key of ['../x.png', 'shreefoods/../../x.png', 'other/0123456789abcdef0123456789abcdef.png', 'shreefoods/', '']) await storage.remove(key);
    expect(sent).toHaveLength(0);
  });
});
