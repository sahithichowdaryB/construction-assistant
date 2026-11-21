/**
 * Authentication boundary for the sign-in and sign-up templates.
 *
 * No identity provider is connected yet. These functions are the only place the forms talk to
 * auth, so connecting one means replacing the bodies here (session cookie, token exchange, or the
 * provider SDK) and nothing in the pages. Until then they resolve without creating a session.
 */
import type { Role } from "@/lib/types";

export interface SignInInput {
  email: string;
  password: string;
  remember: boolean;
}

export interface SignUpInput {
  fullName: string;
  company: string;
  role: Role;
  email: string;
  password: string;
}

// TODO(auth): call the identity provider here and store the session.
export async function signIn(input: SignInInput): Promise<void> {
  void input;
}

// TODO(auth): create the account, send the verification email, then sign the user in.
export async function signUp(input: SignUpInput): Promise<void> {
  void input;
}
