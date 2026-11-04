import { z } from 'zod';

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

export const submitReviewSchema = z.object({
  rating: z.number().int('Choose a rating from 1 to 5').min(1, 'Choose a rating from 1 to 5').max(5, 'Choose a rating from 1 to 5'),
  comment: z.preprocess(blankToUndefined, z.string().trim().max(500, 'Please keep your review under 500 characters').optional()),
  displayName: z.preprocess(blankToUndefined, z.string().trim().min(1).max(40).optional()),
});
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;

export const moderateReviewSchema = z
  .object({
    status: z.enum(['PENDING', 'PUBLISHED', 'HIDDEN']).optional(),
    /** Empty text clears the reply. Leave the field out to keep it as is. */
    reply: z.preprocess(blankToNull, z.string().trim().max(500, 'Keep the reply under 500 characters').nullable()).optional(),
  })
  .refine((v) => v.status !== undefined || v.reply !== undefined, { message: 'Nothing to change' });
export type ModerateReviewInput = z.infer<typeof moderateReviewSchema>;

export const adminReviewsQuery = z.object({
  status: z.enum(['PENDING', 'PUBLISHED', 'HIDDEN']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type AdminReviewsQuery = z.infer<typeof adminReviewsQuery>;

/**
 * What the public sees next to a review: first name plus last initial ("Asha Patel" -> "Asha P.").
 * Never an email or phone number.
 */
export function publicName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Customer';
  if (parts.length === 1) return parts[0].slice(0, 40);
  const last = parts[parts.length - 1];
  return `${parts[0]} ${last.charAt(0).toUpperCase()}.`.slice(0, 40);
}

/** A name a customer typed themselves must not smuggle in contact details. */
export function looksLikeContactDetails(name: string): boolean {
  return /@|https?:|www\./i.test(name) || /\d{5,}/.test(name.replace(/[\s().-]/g, ''));
}
