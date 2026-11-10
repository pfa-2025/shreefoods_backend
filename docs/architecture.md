# Architecture notes

- **Money** is stored as integer cents everywhere; tax rate is basis points (`taxRateBps`).
- **Orders** keep payment and fulfillment status separate. `OrderItem` rows snapshot name and price.
- **OrderEvent** is an append-only log with a monotonic `seq`. The live dashboard uses it to
  recover missed orders after a reconnect and to dedupe hooter alerts (by event id).
- **Customer order access** uses `Order.publicToken` (unguessable), never the sequential `orderNumber`.
- **Auth** (Module 6): server-side sessions (`AdminSession`, hashed token, httpOnly cookie).
- **Settings**: singleton `SiteSettings` row holds tax rate, enabled fulfillment types, payment QR.
  Delivery stays disabled until fees and address handling are configured.
- **Errors**: all API errors share one JSON shape (`AllExceptionsFilter`); input validated with Zod.
- **Next.js** uses Cache Components: data fetching is dynamic by default, so API calls on a page
  must sit inside `<Suspense>`.
- Pinned: Nest 11 (CommonJS; Nest 12 is ESM-only) and Prisma 6 (stable; latest was an RC).
