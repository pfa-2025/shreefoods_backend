import { assertLocalDatabase } from '../scripts/local-only';

export default function globalSetup(): void {
  assertLocalDatabase(process.env.DATABASE_URL, 'The API tests');
}
