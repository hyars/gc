import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { apiGet, apiPost, ApiError } from "./api";
import { resetAccountToken } from "./identity";
import type { MeResponse, Profile, SessionUser } from "./types";

type AuthState = {
  user: SessionUser | null;
  profile: Profile | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setProfile: (profile: Profile) => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await apiGet<MeResponse>("me");
      setUser(data.user);
      setProfileState(data.profile);
    } catch (cause) {
      const api = cause instanceof ApiError ? cause : null;
      // A rejected device token is unrecoverable in place: mint a fresh one.
      if (api && api.code === "access_denied") {
        resetAccountToken();
        try {
          const data = await apiGet<MeResponse>("me");
          setUser(data.user);
          setProfileState(data.profile);
          return;
        } catch (second) {
          setUser(null);
          setProfileState(null);
          setError(second instanceof ApiError ? second.message : "The service is unavailable.");
          return;
        }
      }
      setUser(null);
      setProfileState(null);
      setError(api ? api.message : "The service is unavailable.");
    }
  }, []);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  const value = useMemo(
    () => ({ user, profile, loading, error, refresh, setProfile: setProfileState }),
    [user, profile, loading, error, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}

// First-run step: the player writes the account name other players see.
export function SetupAccount() {
  const { refresh } = useAuth();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await apiPost({ action: "update-profile", displayName: name });
      await refresh();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "That request failed. Try again.");
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background p-6 text-center">
      <div className="space-y-3">
        <div className="text-6xl" aria-hidden>♞</div>
        <h1 className="text-3xl font-bold tracking-tight">Set up your account</h1>
        <p className="max-w-md text-muted-foreground">
          Pick the name other players see on the board. Your account is saved in this browser, so
          you stay signed in automatically.
        </p>
      </div>
      <form onSubmit={save} className="flex w-full max-w-xs flex-col gap-3">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={30}
          autoFocus
          aria-label="Player name"
          placeholder="Player name"
          className="h-12 rounded-lg border border-border bg-card px-4 text-center text-base shadow-sm outline-none focus:ring-2 focus:ring-foreground/20"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className="h-12 rounded-lg bg-foreground text-base font-semibold text-background transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Start playing"}
        </button>
      </form>
      <p className="max-w-sm text-xs text-muted-foreground">
        This account is remembered in this browser. Clearing site data starts a new one.
      </p>
    </main>
  );
}

export function StartErrorScreen({ message }: { message?: string }) {
  const { refresh } = useAuth();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background p-6 text-center">
      <div className="space-y-3">
        <div className="text-6xl" aria-hidden>♞</div>
        <h1 className="text-3xl font-bold tracking-tight">Gambit</h1>
        <p className="max-w-md text-muted-foreground">
          Your account couldn't be started right now.
        </p>
      </div>
      {message && <p className="max-w-md text-sm text-muted-foreground">{message}</p>}
      <button
        onClick={() => void refresh()}
        className="h-11 rounded-lg border border-border bg-card px-6 text-base font-medium shadow-sm transition hover:bg-muted"
      >
        Try again
      </button>
    </main>
  );
}
