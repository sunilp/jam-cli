import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AgentMessage, ContentPart } from './types.js';
import type { Message } from '../providers/base.js';
import { JamError } from '../utils/errors.js';

/**
 * Extracts the plain text content from an AgentMessage.
 * If content is a string, returns it as-is.
 * If content is a ContentPart[], filters for text parts and joins their text values.
 */
export function getTextContent(msg: AgentMessage): string {
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  return msg.content
    .filter((part): part is ContentPart & { type: 'text'; text: string } =>
      part.type === 'text' && part.text !== undefined
    )
    .map(part => part.text)
    .join('');
}

/**
 * Returns true if the message content is a ContentPart[] with at least one image part.
 */
export function hasImages(msg: AgentMessage): boolean {
  if (typeof msg.content === 'string') {
    return false;
  }
  return msg.content.some(part => part.type === 'image');
}

/**
 * Converts AgentMessage[] to standard Message[] (string content).
 * For each message: if content is a string, pass through.
 * If content is a ContentPart[], extract text via getTextContent().
 * If !supportsVision and the message had images, appends a notice.
 */
export function flattenForProvider(
  messages: AgentMessage[],
  supportsVision: boolean
): Message[] {
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }

    const textContent = getTextContent(msg);
    const hadImages = hasImages(msg);

    let content = textContent;
    if (!supportsVision && hadImages) {
      content = textContent + '\n[Image provided but this model does not support vision]';
    }

    return { role: msg.role, content };
  });
}

/**
 * Reads an image file and returns base64-encoded data with detected media type.
 * Throws JamError with code 'INPUT_FILE_NOT_FOUND' if the file does not exist.
 */
export async function loadImage(filePath: string): Promise<{
  data: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}> {
  if (!existsSync(filePath)) {
    throw new JamError(
      `Image file not found: ${filePath}`,
      'INPUT_FILE_NOT_FOUND'
    );
  }

  const ext = extname(filePath).toLowerCase();
  let mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

  switch (ext) {
    case '.png':
      mediaType = 'image/png';
      break;
    case '.jpg':
    case '.jpeg':
      mediaType = 'image/jpeg';
      break;
    case '.gif':
      mediaType = 'image/gif';
      break;
    case '.webp':
      mediaType = 'image/webp';
      break;
    default:
      throw new JamError(
        `Unsupported image format: ${ext}. Supported formats: .png, .jpg, .jpeg, .gif, .webp`,
        'INPUT_FILE_NOT_FOUND'
      );
  }

  const buffer = await readFile(filePath);
  return { data: buffer.toString('base64'), mediaType };
}
