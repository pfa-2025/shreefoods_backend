import type { Prisma } from '@prisma/client';

/** MySQL has no array columns, so dietary labels are stored as JSON; read them back as a clean string list. */
export function asLabels(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
