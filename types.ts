export type Mode = "bot" | "online";
export type GameStatus = "waiting" | "active" | "finished";

export type Profile = {
  user_id: string;
  display_name: string;
  picture: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  bot_wins: number;
  bot_losses: number;
  bot_draws: number;
  puzzles_solved: number;
  created_at: string;
  updated_at: string;
};

export type MoveRecord = { u: string; s: string };

export type AnalysisPly = {
  ply: number;
  san: string;
  uci: string;
  color: "w" | "b";
  evalBefore: number;
  evalAfter: number;
  bestUci: string | null;
  bestSan: string | null;
  classification: string;
};

export type AnalysisSummary = {
  accuracyWhite: number;
  accuracyBlack: number;
  openingName: string | null;
};

export type Game = {
  id: string;
  mode: Mode;
  status: GameStatus;
  creator_id: string;
  white_id: string | null;
  black_id: string | null;
  white_name: string;
  black_name: string;
  white_picture: string;
  black_picture: string;
  bot_level: number | null;
  bot_side: "w" | "b" | null;
  result: "1-0" | "0-1" | "1/2-1/2" | null;
  termination: string | null;
  winner_id: string | null;
  moves: MoveRecord[];
  move_count: number;
  draw_offered_by: string | null;
  white_time_ms: number | null;
  black_time_ms: number | null;
  initial_time_ms: number;
  last_move_at: string | null;
  analysis: (AnalysisSummary & { plies: AnalysisPly[] }) | null;
  created_at: string;
  updated_at: string;
};

export type SessionUser = { id: string; name: string; picture: string };

export type MeResponse = { user: SessionUser; profile: Profile };
export type ProfileResponse = { profile: Profile };
export type LobbyResponse = { games: Game[] };
export type GameResponse = { game: Game };
export type MyGamesResponse = { items: Game[]; hasMore: boolean; nextOffset: number };

export const TIME_CONTROLS = [
  { label: "1 min", ms: 60000, name: "Bullet" },
  { label: "3 min", ms: 180000, name: "Blitz" },
  { label: "5 min", ms: 300000, name: "Blitz" },
  { label: "10 min", ms: 600000, name: "Rapid" },
];

export function resultText(game: { result: string | null; termination: string | null }): string {
  const term: Record<string, string> = {
    checkmate: "by checkmate",
    resign: "by resignation",
    timeout: "on time",
    agreement: "by agreement",
    stalemate: "by stalemate",
    insufficient: "insufficient material",
    threefold: "by repetition",
    aborted: "aborted",
  };
  if (!game.result) return "";
  const base = game.result === "1-0" ? "White won" : game.result === "0-1" ? "Black won" : "Draw";
  return `${base} ${term[game.termination ?? ""] ?? ""}`.trim();
}
