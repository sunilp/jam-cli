import { describe, it, expect } from 'vitest';
import { getTextContent, hasImages, flattenForProvider, loadImage } from './multimodal.js';
import type { AgentMessage } from './types.js';

describe('getTextContent', () => {
  it('returns string content as-is', () => {
    const msg: AgentMessage = { role: 'user', content: 'hello' };
    expect(getTextContent(msg)).toBe('hello');
  });

  it('extracts text from ContentPart array', () => {
    const msg: AgentMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this' },
        { type: 'image', image: { data: 'abc', mediaType: 'image/png' } },
      ],
    };
    expect(getTextContent(msg)).toBe('Describe this');
  });

  it('joins multiple text parts', () => {
    const msg: AgentMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ],
    };
    expect(getTextContent(msg)).toBe('Part 1Part 2');
  });

  it('returns empty string for image-only content', () => {
    const msg: AgentMessage = {
      role: 'user',
      content: [{ type: 'image', image: { data: 'abc', mediaType: 'image/png' } }],
    };
    expect(getTextContent(msg)).toBe('');
  });
});

describe('hasImages', () => {
  it('returns false for string content', () => {
    expect(hasImages({ role: 'user', content: 'hello' })).toBe(false);
  });

  it('returns true when content has image parts', () => {
    expect(hasImages({
      role: 'user',
      content: [{ type: 'image', image: { data: 'abc', mediaType: 'image/png' } }],
    })).toBe(true);
  });

  it('returns false for text-only ContentPart array', () => {
    expect(hasImages({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    })).toBe(false);
  });
});

describe('flattenForProvider', () => {
  it('passes through string-content messages unchanged', () => {
    const msgs: AgentMessage[] = [{ role: 'user', content: 'hello' }];
    const result = flattenForProvider(msgs, false);
    expect(result[0].content).toBe('hello');
  });

  it('flattens ContentPart to text for non-vision providers', () => {
    const msgs: AgentMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this' },
        { type: 'image', image: { data: 'abc', mediaType: 'image/png' } },
      ],
    }];
    const result = flattenForProvider(msgs, false);
    expect(typeof result[0].content).toBe('string');
    expect(result[0].content).toContain('Describe this');
    expect(result[0].content).toContain('[Image provided');
  });

  it('flattens ContentPart to text for vision providers too', () => {
    const msgs: AgentMessage[] = [{
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    }];
    const result = flattenForProvider(msgs, true);
    expect(result[0].content).toBe('hello');
  });

  it('handles mixed string and ContentPart messages', () => {
    const msgs: AgentMessage[] = [
      { role: 'user', content: 'plain text' },
      { role: 'user', content: [{ type: 'text', text: 'array text' }] },
    ];
    const result = flattenForProvider(msgs, false);
    expect(result[0].content).toBe('plain text');
    expect(result[1].content).toBe('array text');
  });
});

describe('loadImage', () => {
  it('loads a PNG file', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const path = '/tmp/test-jam-multimodal.png';
    await writeFile(path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const result = await loadImage(path);
    expect(result.mediaType).toBe('image/png');
    expect(result.data).toBeTruthy();
    expect(typeof result.data).toBe('string'); // base64
    await unlink(path);
  });

  it('detects JPEG media type', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const path = '/tmp/test-jam-multimodal.jpg';
    await writeFile(path, Buffer.from([0xFF, 0xD8, 0xFF]));
    const result = await loadImage(path);
    expect(result.mediaType).toBe('image/jpeg');
    await unlink(path);
  });

  it('throws for non-existent file', async () => {
    await expect(loadImage('/tmp/nonexistent-image-12345.png')).rejects.toThrow();
  });
});
