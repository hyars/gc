// Automatic device account: a random 256-bit bearer token created on first
// visit and kept in this browser. The server derives the account ID from it.
const STORAGE_KEY = "gambit.account.v1";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

let memory: string | null = null;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function accountToken(): string {
  if (memory) return memory;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && TOKEN.test(stored)) {
      memory = stored;
      return stored;
    }
  } catch {
    // Storage unavailable; fall back to a session-only account.
  }
  const token = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  memory = token;
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Keep the in-memory token for this tab.
  }
  return token;
}

export function resetAccountToken(): string {
  memory = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
  return accountToken();
}
