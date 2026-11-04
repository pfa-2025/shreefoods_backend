/** Delivery boundary for password-reset links. The email-based implementation lives in the EmailModule. */
export abstract class PasswordResetNotifier {
  abstract send(email: string, token: string): Promise<void>;
}
