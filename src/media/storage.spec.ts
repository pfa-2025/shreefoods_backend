import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalStorage, cloudinarySignature } from './storage';

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
