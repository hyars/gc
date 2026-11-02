// Same-origin Function client. Adapts the Sites request helper: known error
// codes map to product-language messages; raw server text is never displayed.
import { accountToken } from "./identity";

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number = 0) {
    super(message);
    this.name = "ApiError";
  }
}

const MESSAGES: Record<string, string> = {
  network_error: "Connection problem. Check your network and try again.",
  invalid_response: "The site service returned an unexpected response.",
  login_required: "Please sign in to continue.",
  access_denied: "Check your site access and sign in again.",
  not_found: "That game could not be found.",
  game_taken: "Someone already joined that game.",
  not_your_turn: "It is not your turn.",
  illegal_move: "That move is not legal.",
  version_conflict: "The game changed while you were moving. Refreshing.",
  invalid_input: "That request was invalid.",
  profile_incomplete: "Write your player name first.",
  game_over: "This game is already over.",
  request_failed: "The request failed. Try again.",
  service_unavailable: "The service is temporarily unavailable. Try again shortly.",
};

export async function apiGet<T>(action: string, params: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams({ action, ...params });
  return requestJson<T>(`/functions/v1/app?${query.toString()}`);
}

export async function apiPost<T>(body: Record<string, unknown>): Promise<T> {
  return requestJson<T>("/functions/v1/app", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("x-gambit-account", accountToken());
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, credentials: "same-origin" });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(MESSAGES.network_error, "network_error");
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(MESSAGES.access_denied, "access_denied", response.status);
  }
  if (response.redirected || !response.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(MESSAGES.invalid_response, "invalid_response", response.status);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(MESSAGES.invalid_response, "invalid_response", response.status);
  }
  const body = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const code = typeof body?.error === "string" ? body.error : !response.ok && typeof body?.code === "string" ? body.code : response.ok ? null : "request_failed";
  if (!response.ok || body?.ok === false || code) {
    const resolved = code ?? "request_failed";
    throw new ApiError(MESSAGES[resolved] ?? MESSAGES.request_failed, resolved, response.status);
  }
  return data as T;
}
