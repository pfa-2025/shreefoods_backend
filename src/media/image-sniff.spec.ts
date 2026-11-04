import { sniffImage } from './image-sniff';

describe('sniffImage', () => {
  it('recognises JPEG, PNG and WebP by magic bytes', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))?.ext).toBe('jpg');
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.ext).toBe('png');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]))?.ext).toBe('webp');
  });
  it('rejects SVG, HTML, scripts, GIF and empty input', () => {
    for (const text of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<html></html>', 'GIF89a....', '']) {
      expect(sniffImage(Buffer.from(text))).toBeNull();
    }
  });
  it('is not fooled by a text file that merely ends in .png', () => {
    expect(sniffImage(Buffer.from('not really a png'))).toBeNull();
  });
});
