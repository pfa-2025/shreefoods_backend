import { z } from 'zod';

/** http(s) URLs only: blocks javascript:, data: and friends. */
export const safeUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      return ['https:', 'http:'].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, 'Enter a full web address starting with https://');

/** An on-site path ("/menu") or a full web address. */
export const linkTarget = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^\/(?!\/)[^\s]*$/.test(v) || safeUrl.safeParse(v).success, 'Use a path like /menu or a full https:// address');

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optionalText = (max: number) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable());

export const idList = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) });
export type IdListInput = z.infer<typeof idList>;

// ---------- menu ----------
export const MAX_PRICE_CENTS = 1_000_000; // $10,000: a typo guard, not a business rule
export const dietaryLabels = z
  .array(z.string().trim().toLowerCase().min(1).max(24).regex(/^[a-z0-9 -]+$/, 'Letters, numbers, spaces and hyphens only'))
  .max(8);

export const categorySchema = z.object({ name: z.string().trim().min(1, 'Enter a name').max(60) });
export const categoryPatch = z.object({ name: z.string().trim().min(1).max(60).optional(), isArchived: z.boolean().optional() });

const itemBase = z.object({
  categoryId: z.string().min(1).max(64),
  name: z.string().trim().min(1, 'Enter a name').max(80),
  description: z.string().trim().max(500),
  priceCents: z.number().int('Price must be a whole number of cents').min(1, 'Price must be above $0').max(MAX_PRICE_CENTS, 'Price is too high'),
  imageId: z.preprocess(emptyToNull, z.string().max(64).nullable()),
  dietaryLabels: dietaryLabels,
  isFeatured: z.boolean(),
  isAvailable: z.boolean(),
});
// Create fills in defaults; patch must NOT (an omitted field means "leave it alone").
export const itemSchema = itemBase.extend({
  description: itemBase.shape.description.default(''),
  imageId: itemBase.shape.imageId.default(null),
  dietaryLabels: itemBase.shape.dietaryLabels.default([]),
  isFeatured: itemBase.shape.isFeatured.default(false),
  isAvailable: itemBase.shape.isAvailable.default(true),
});
export const itemPatch = itemBase.partial().extend({ isArchived: z.boolean().optional() });
export const availabilitySchema = z.object({ isAvailable: z.boolean() });
export const itemOrderSchema = idList.extend({ categoryId: z.string().min(1).max(64) });
export type CategoryInput = z.infer<typeof categorySchema>;
export type CategoryPatch = z.infer<typeof categoryPatch>;
export type ItemInput = z.infer<typeof itemSchema>;
export type ItemPatch = z.infer<typeof itemPatch>;
export type ItemOrderInput = z.infer<typeof itemOrderSchema>;

// ---------- announcements ----------
const announcementBase = z.object({
  title: z.string().trim().min(1, 'Enter a title').max(80),
  body: z.string().trim().max(300),
  imageId: z.preprocess(emptyToNull, z.string().max(64).nullable()),
  linkUrl: z.preprocess(emptyToNull, linkTarget.nullable()),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
  publishAt: z.preprocess(emptyToNull, z.string().datetime({ offset: true }).nullable()),
});
export const announcementSchema = announcementBase.extend({
  body: announcementBase.shape.body.default(''),
  imageId: announcementBase.shape.imageId.default(null),
  linkUrl: announcementBase.shape.linkUrl.default(null),
  status: announcementBase.shape.status.default('DRAFT'),
  publishAt: announcementBase.shape.publishAt.default(null),
});
export const announcementPatch = announcementBase.partial();
export type AnnouncementInput = z.infer<typeof announcementSchema>;
export type AnnouncementPatch = z.infer<typeof announcementPatch>;

// ---------- pages & SEO ----------
export const PAGE_KEYS = ['home', 'menu', 'story', 'reviews', 'contact', 'affiliations'] as const;
export type PageKey = (typeof PAGE_KEYS)[number];
export const pageKey = z.enum(PAGE_KEYS);

const para = z.string().trim().min(1).max(1200);
export const pageContent: Record<PageKey, z.ZodType<Record<string, unknown>>> = {
  home: z.object({ heroEyebrow: z.string().trim().max(60), heroTitle: z.string().trim().min(1).max(120), heroText: z.string().trim().max(300) }),
  menu: z.object({ intro: z.string().trim().max(300) }),
  story: z.object({ headline: z.string().trim().min(1).max(120), paragraphs: z.array(para).min(1).max(6) }),
  reviews: z.object({ intro: z.string().trim().max(300), links: z.array(z.object({ platform: z.string().trim().min(1).max(40), url: safeUrl })).max(10) }),
  contact: z.object({ intro: z.string().trim().max(300) }),
  affiliations: z.object({ intro: z.string().trim().max(300), items: z.array(z.object({ name: z.string().trim().min(1).max(80), url: z.preprocess(emptyToNull, safeUrl.nullable()).default(null) })).max(30) }),
};

export const seoSchema = z.object({
  title: optionalText(70),
  description: optionalText(200),
  imageUrl: z.preprocess(emptyToNull, z.string().trim().max(500).refine((v) => /^\/(?!\/)[^\s]*$/.test(v) || safeUrl.safeParse(v).success, 'Pick an uploaded image or enter a full https:// address').nullable()),
  canonicalUrl: z.preprocess(emptyToNull, safeUrl.nullable()),
  noIndex: z.boolean(),
});
export type SeoInput = z.infer<typeof seoSchema>;

// ---------- settings ----------
export const settingsSchema = z
  .object({
    restaurantName: z.string().trim().min(1).max(80),
    phone: optionalText(30),
    email: z.preprocess(emptyToNull, z.string().trim().toLowerCase().email().max(254).nullable()),
    address: optionalText(200),
    openingHours: z.array(z.object({ day: z.string().trim().min(1).max(40), hours: z.string().trim().min(1).max(60) })).max(14),
    socialLinks: z.array(z.object({ label: z.string().trim().min(1).max(30), url: safeUrl })).max(8),
    taxRateBps: z.number().int().min(0).max(2500, 'Tax rate can’t exceed 25%'),
    pickupEnabled: z.boolean(),
    dineInEnabled: z.boolean(),
    ordersOpen: z.boolean(),
    cartEnabled: z.boolean(),
    paymentQrId: z.preprocess(emptyToNull, z.string().max(64).nullable()),
    paymentHandle: optionalText(100),
    paymentInstructions: z.string().trim().max(500),
  })
  .refine((v) => v.pickupEnabled || v.dineInEnabled, { message: 'Enable at least one order type', path: ['pickupEnabled'] });
export type SettingsInput = z.infer<typeof settingsSchema>;
