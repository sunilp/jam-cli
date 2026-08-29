import { z } from 'zod';
import type { Tool, Disposable } from './types.js';

export interface ProviderToolDefinition {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

/**
 * The JSON type for one field. Throws on a shape it does not model, rather
 * than defaulting to 'string': a silent mistype is exactly the schema/validator
 * drift that generating from zod exists to prevent. Extend this rather than
 * letting a tool ship a provider schema its validator will reject.
 */
function jsonTypeOf(field: z.ZodTypeAny): Record<string, unknown> {
  if (field instanceof z.ZodString) return { type: 'string' };
  if (field instanceof z.ZodNumber) return { type: 'number' };
  if (field instanceof z.ZodBoolean) return { type: 'boolean' };
  if (field instanceof z.ZodEnum) {
    return { type: 'string', enum: (field as z.ZodEnum<[string, ...string[]]>).options };
  }
  if (field instanceof z.ZodArray) {
    return { type: 'array', items: jsonTypeOf((field as z.ZodArray<z.ZodTypeAny>).element) };
  }
  throw new Error(
    `toJsonSchema does not model ${field.constructor.name}. Add a branch for it ` +
    `instead of letting the provider schema drift from the zod validator.`
  );
}

/** Minimal zod -> JSON Schema for the object shapes our tools use. */
function toJsonSchema(schema: z.ZodTypeAny): ProviderToolDefinition['parameters'] {
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape ?? {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, raw] of Object.entries(shape)) {
    let field = raw;
    let optional = false;
    while (field instanceof z.ZodOptional || field instanceof z.ZodDefault) {
      optional = true;
      field = field._def.innerType as z.ZodTypeAny;
    }
    const description = field.description;
    const shapeOf = jsonTypeOf(field);

    properties[key] = description === undefined ? shapeOf : { ...shapeOf, description };
    if (!optional) required.push(key);
  }

  return required.length
    ? { type: 'object', properties, required }
    : { type: 'object', properties };
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<never, unknown>>();

  register<I, O>(tool: Tool<I, O>): Disposable {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool as unknown as Tool<never, unknown>);
    return { dispose: () => { this.tools.delete(tool.name); } };
  }

  get(name: string): Tool<never, unknown> | undefined { return this.tools.get(name); }
  list(): Array<Tool<never, unknown>> { return [...this.tools.values()]; }

  definitions(): ProviderToolDefinition[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t.input as z.ZodTypeAny),
    }));
  }
}
