import { useCallback, useEffect, useState } from "react";
import { AuthProvider, SetupAccount, StartErrorScreen, useAuth } from "./auth";
import { loadGame } from "./hooks/useGameSession";
import { HomeView } from "./views/HomeView";
import { BotSetupView } from "./views/BotSetupView";
import { GameView } from "./views/GameView";
import { MyGamesView } from "./views/MyGamesView";
import { ProfileView } from "./views/ProfileView";
import { PuzzleView } from "./views/PuzzleView";
import { ReviewView } from "./views/ReviewView";
import type { Game } from "./types";

const gameCache = new Map<string, Game>();

function useHashRoute(): [string, (to: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((to: string) => {
    window.location.hash = to;
  }, []);
  return [hash, navigate];
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

function Shell() {
  const { user, profile, loading, error } = useAuth();
  const [route, navigate] = useHashRoute();

  const openGame = useCallback((game: Game) => {
    gameCache.set(game.id, game);
    navigate(`#/game/${game.id}`);
  }, [navigate]);

  const openReview = useCallback((game: Game) => {
    gameCache.set(game.id, game);
    navigate(`#/review/${game.id}`);
  }, [navigate]);

  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <span className="text-5xl" aria-hidden>♞</span>
          <p className="text-sm text-muted-foreground">Loading Gambit…</p>
        </div>
      </main>
    );
  }
  if (!user) return <StartErrorScreen message={error ?? undefined} />;
  if (profile && !profile.display_name) return <SetupAccount />;

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4">
          <button className="flex items-center gap-2 text-lg font-extrabold tracking-tight" onClick={() => navigate("#/")}>
            <span className="text-2xl" aria-hidden>♞</span> Gambit
          </button>
          <nav className="ml-2 flex items-center gap-1 text-sm">
            <button className="rounded-md px-3 py-1.5 font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground" onClick={() => navigate("#/")}>
              Play
            </button>
            <button className="rounded-md px-3 py-1.5 font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground" onClick={() => navigate("#/games")}>
              My games
            </button>
            <button className="rounded-md px-3 py-1.5 font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground" onClick={() => navigate("#/puzzles")}>
              Puzzles
            </button>
          </nav>
          <div className="ml-auto flex items-center gap-2.5">
            {profile && <span className="hidden text-sm font-bold tabular-nums text-muted-foreground sm:block" title="Online rating">{profile.rating}</span>}
            <button
              className="flex items-center gap-2.5 rounded-md px-2 py-1 transition hover:bg-muted"
              onClick={() => navigate("#/profile")}
              aria-label="Your account"
            >
              {user.picture ? (
                <img src={user.picture} alt="" width={32} height={32} referrerPolicy="no-referrer" className="h-8 w-8 rounded-md object-cover" />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded-md bg-muted" aria-hidden>👤</span>
              )}
              <span className="hidden max-w-32 truncate text-sm font-semibold sm:block">{profile?.display_name || user.name || "Player"}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Router route={route} navigate={navigate} openGame={openGame} openReview={openReview} />
      </main>

      <footer className="border-t border-border py-4 text-center text-xs text-muted-foreground">
        Engine: Stockfish (GPL-3.0) compiled to WebAssembly · Pieces & board in the classic style
      </footer>
    </div>
  );
}

function Router({ route, navigate, openGame, openReview }: {
  route: string;
  navigate: (to: string) => void;
  openGame: (game: Game) => void;
  openReview: (game: Game) => void;
}) {
  const gameMatch = route.match(/^#\/game\/([\w-]+)$/);
  const reviewMatch = route.match(/^#\/review\/([\w-]+)$/);

  if (gameMatch) {
    return <GameLoader key={gameMatch[1]} id={gameMatch[1]} navigate={navigate} openReview={openReview} />;
  }
  if (reviewMatch) {
    return <ReviewLoader key={reviewMatch[1]} id={reviewMatch[1]} navigate={navigate} />;
  }
  if (route === "#/bot") {
    return <BotSetupView onBack={() => navigate("#/")} onStart={openGame} />;
  }
  if (route === "#/games") {
    return <MyGamesView onBack={() => navigate("#/")} onOpenGame={openGame} />;
  }
  if (route === "#/profile") {
    return <ProfileView />;
  }
  if (route === "#/puzzles") {
    return <PuzzleView />;
  }
  return <HomeView onOpenGame={openGame} onBotSetup={() => navigate("#/bot")} onAllGames={() => navigate("#/games")} onPuzzles={() => navigate("#/puzzles")} />;
}

function GameLoader({ id, navigate, openReview }: {
  id: string;
  navigate: (to: string) => void;
  openReview: (game: Game) => void;
}) {
  const [game, setGame] = useState<Game | null>(() => gameCache.get(id) ?? null);
  useEffect(() => {
    if (game) return;
    let cancelled = false;
    void loadGame(id).then((loaded) => {
      if (!cancelled && loaded) {
        gameCache.set(id, loaded);
        setGame(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id, game]);

  if (!game) {
    return <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">Loading game…</div>;
  }
  return (
    <GameView
      initialGame={game}
      onExit={() => navigate("#/")}
      onNewBotGame={() => navigate("#/bot")}
      onReview={(finished) => openReview(finished)}
    />
  );
}

function ReviewLoader({ id, navigate }: {
  id: string;
  navigate: (to: string) => void;
}) {
  const [game, setGame] = useState<Game | null>(() => gameCache.get(id) ?? null);
  useEffect(() => {
    if (game) return;
    let cancelled = false;
    void loadGame(id).then((loaded) => {
      if (!cancelled && loaded) {
        gameCache.set(id, loaded);
        setGame(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id, game]);

  if (!game) {
    return <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">Loading game…</div>;
  }
  return (
    <ReviewView
      game={game}
      onExit={() => navigate(`#/game/${id}`)}
      onNewGame={() => navigate("#/")}
    />
  );
}
