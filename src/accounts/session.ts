import { credentialAccountId } from "./crypto";
import { SESSION_MILLISECONDS } from "./model";

export const SESSION_COOKIE = "__Host-mcp_starter_session";

export function readSessionCookie(header: string | null | undefined) {
  if (!header || header.length > 8192) return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const token = values.length === 1 ? values[0].slice(SESSION_COOKIE.length + 1) : null;
  return token && credentialAccountId(token) ? token : null;
}

export const sessionCookie = (token: string) =>
  `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MILLISECONDS / 1000}; HttpOnly; Secure; SameSite=Strict`;

export const clearSessionCookie = () =>
  `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
