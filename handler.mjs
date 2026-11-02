// Gambit chess application handler. All actions run behind the Gateway-verified
// user context; the database is reached only through this handler.
import { Chess } from "./chessjs.mjs";
import { requireUser, UserContextError } from "./auth.mjs";

const GAMES = "games";
const PROFILES = "profiles";
const MAX_BODY_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const TIME_CONTROLS = new Set([60000, 180000, 300000, 600000]);
const BOT_LEVELS = new Map([
  [1, { name: "Pip", elo: 350 }],
  [2, { name: "Milo", elo: 600 }],
  [3, { name: "Nora", elo: 900 }],
  [4, { name: "Sami", elo: 1200 }],
  [5, { name: "Isla", elo: 1500 }],
  [6, { name: "Viktor", elo: 1800 }],
  [7, { name: "Clara", elo: 2100 }],
  [8, { name: "Nova", elo: 2400 }],
  [9, { name: "Titan", elo: 2800 }],
]);
const CLASSIFICATIONS = new Set([
  "brilliant", "great", "best", "excellent", "book", "good", "inaccuracy", "mistake", "blunder",
]);
const TERMINATIONS = new Set([
  "checkmate", "resign", "timeout", "agreement", "stalemate", "insufficient", "threefold", "fifty", "aborted",
]);

const now = () => new Date().toISOString();

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function fail(code, status = 400) {
  return json({ error: code }, status);
}

export async function handleChess({ request, supabase }) {
  try {
    const url = new URL(request.url);
    const user = await requireUser(request);
    if (request.method === "GET") {
      const action = url.searchParams.get("action") ?? "";
      return await handleGet(action, url, user, supabase);
    }
    if (request.method === "POST") {
      const body = await readBody(request);
      const action = typeof body.action === "string" ? body.action : "";
      return await handlePost(action, body, user, supabase);
    }
    return fail("method_not_allowed", 405);
  } catch (error) {
    if (error instanceof UserContextError) return fail(error.code, error.status);
    if (error instanceof AppError) return fail(error.code, error.status);
    return fail("service_unavailable", 503);
  }
}

class AppError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function handleGet(action, url, user, supabase) {
  if (action === "me") {
    const profile = await ensureProfile(supabase, user);
    return json({ user: { id: user.user_id, name: user.name, picture: user.picture }, profile });
  }
  if (action === "lobby") {
    const { data, error } = await supabase
      .from(GAMES)
      .select("*")
      .eq("status", "waiting")
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) throw new AppError("service_unavailable", 503);
    return json({ games: data });
  }
  if (action === "game") {
    const id = url.searchParams.get("id") ?? "";
    if (!UUID.test(id)) throw new AppError("invalid_input");
    const row = await fetchGame(supabase, id);
    if (!row) throw new AppError("not_found", 404);
    return json({ game: row });
  }
  if (action === "mygames") {
    const offset = Number(url.searchParams.get("offset") ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new AppError("invalid_input");
    const page = 20;
    const { data, error } = await supabase
      .from(GAMES)
      .select("*")
      .or(`white_id.eq.${user.user_id},black_id.eq.${user.user_id},creator_id.eq.${user.user_id}`)
      .order("updated_at", { ascending: false })
      .range(offset, offset + page);
    if (error) throw new AppError("service_unavailable", 503);
    const items = data ?? [];
    return json({ items, hasMore: items.length > page, nextOffset: offset + page });
  }
  throw new AppError("not_found", 404);
}

async function handlePost(action, body, user, supabase) {
  if (action === "update-profile") return await updateProfile(supabase, user, body);
  if (action === "puzzle-solved") return await recordPuzzleSolved(supabase, user, body);
  if (action === "challenge") return await createChallenge(supabase, user, body);
  if (action === "join") return await joinGame(supabase, user, body);
  if (action === "bot-game") return await createBotGame(supabase, user, body);
  if (action === "move") return await submitMove(supabase, user, body);
  if (action === "resign") return await resignGame(supabase, user, body);
  if (action === "draw") return await drawAction(supabase, user, body);
  if (action === "cancel") return await cancelChallenge(supabase, user, body);
  if (action === "state") return await gameState(supabase, user, body);
  if (action === "save-analysis") return await saveAnalysis(supabase, user, body);
  throw new AppError("not_found", 404);
}

async function readBody(request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new AppError("invalid_input", 413);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new AppError("invalid_input", 413);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    throw new AppError("invalid_input");
  }
}

async function ensureProfile(supabase, user) {
  // The account starts unnamed: the player writes their display name once
  // (update-profile) before playing. The Google name is only a form prefill.
  const { error: insertError } = await supabase
    .from(PROFILES)
    .upsert(
      {
        user_id: user.user_id,
        display_name: "",
        picture: user.picture || "",
        rating: 1200,
        wins: 0,
        losses: 0,
        draws: 0,
        bot_wins: 0,
        bot_losses: 0,
        bot_draws: 0,
        puzzles_solved: 0,
        created_at: now(),
        updated_at: now(),
      },
      { ignoreDuplicates: true },
    );
  if (insertError) throw new AppError("service_unavailable", 503);
  const { data, error } = await supabase.from(PROFILES).select("*").eq("user_id", user.user_id).maybeSingle();
  if (error || !data) throw new AppError("service_unavailable", 503);
  if (data.picture !== (user.picture || "")) {
    const { data: updated, error: updateError } = await supabase
      .from(PROFILES)
      .update({ picture: user.picture || "", updated_at: now() })
      .eq("user_id", user.user_id)
      .select("*")
      .maybeSingle();
    if (!updateError && updated) return updated;
  }
  return data;
}

function requireNamed(profile) {
  if (!profile.display_name) throw new AppError("profile_incomplete", 400);
}

async function updateProfile(supabase, user, body) {
  const displayName = body.displayName;
  if (typeof displayName !== "string") throw new AppError("invalid_input");
  const name = displayName.trim();
  if (name.length < 1 || name.length > 30) throw new AppError("invalid_input");
  for (const ch of name) {
    if (ch < " " || ch === "\x7f") throw new AppError("invalid_input");
  }
  await ensureProfile(supabase, user);
  const { data, error } = await supabase
    .from(PROFILES)
    .update({ display_name: name, updated_at: now() })
    .eq("user_id", user.user_id)
    .select("*")
    .maybeSingle();
  if (error || !data) throw new AppError("service_unavailable", 503);
  return json({ profile: data });
}

// The puzzle set is static and lives in the frontend, so the id is only
// checked for shape here; the UI reports each puzzle once.
async function recordPuzzleSolved(supabase, user, body) {
  const puzzleId = body.puzzleId;
  if (typeof puzzleId !== "string" || !/^[0-9]{1,3}-[0-9]{1,3}$/.test(puzzleId)) {
    throw new AppError("invalid_input");
  }
  const profile = await ensureProfile(supabase, user);
  requireNamed(profile);
  const { data, error } = await supabase
    .from(PROFILES)
    .update({ puzzles_solved: (profile.puzzles_solved ?? 0) + 1, updated_at: now() })
    .eq("user_id", user.user_id)
    .select("*")
    .maybeSingle();
  if (error || !data) throw new AppError("service_unavailable", 503);
  return json({ profile: data });
}

async function fetchGame(supabase, id) {  const { data, error } = await supabase.from(GAMES).select("*").eq("id", id).maybeSingle();
  if (error) throw new AppError("service_unavailable", 503);
  return data ?? null;
}

function resolveColor(choice) {
  if (choice === "white") return "w";
  if (choice === "black") return "b";
  return Math.random() < 0.5 ? "w" : "b";
}

async function createChallenge(supabase, user, body) {
  const timeMs = body.timeMs;
  if (!TIME_CONTROLS.has(timeMs)) throw new AppError("invalid_input");
  const color = resolveColor(body.color);
  const profile = await ensureProfile(supabase, user);
  requireNamed(profile);
  const row = {
    id: crypto.randomUUID(),
    mode: "online",
    status: "waiting",
    creator_id: user.user_id,
    white_id: color === "w" ? user.user_id : null,
    black_id: color === "b" ? user.user_id : null,
    white_name: color === "w" ? profile.display_name : "",
    black_name: color === "b" ? profile.display_name : "",
    white_picture: color === "w" ? profile.picture : "",
    black_picture: color === "b" ? profile.picture : "",
    moves: [],
    move_count: 0,
    initial_time_ms: timeMs,
    white_time_ms: timeMs,
    black_time_ms: timeMs,
    created_at: now(),
    updated_at: now(),
  };
  const { data, error } = await supabase.from(GAMES).insert(row).select("*").single();
  if (error || !data) throw new AppError("service_unavailable", 503);
  return json({ game: data });
}

async function joinGame(supabase, user, body) {
  const gameId = body.gameId;
  if (typeof gameId !== "string" || !UUID.test(gameId)) throw new AppError("invalid_input");
  const game = await fetchGame(supabase, gameId);
  if (!game) throw new AppError("not_found", 404);
  if (game.status !== "waiting") throw new AppError("game_taken", 409);
  if (game.creator_id === user.user_id) throw new AppError("invalid_input");
  const profile = await ensureProfile(supabase, user);
  requireNamed(profile);
  const white = game.white_id ? {} : {
    white_id: user.user_id,
    white_name: profile.display_name,
    white_picture: profile.picture,
  };
  const black = game.black_id ? {} : {
    black_id: user.user_id,
    black_name: profile.display_name,
    black_picture: profile.picture,
  };
  const { data, error } = await supabase
    .from(GAMES)
    .update({ ...white, ...black, status: "active", last_move_at: now(), updated_at: now() })
    .eq("id", gameId)
    .eq("status", "waiting")
    .select("*")
    .maybeSingle();
  if (error) throw new AppError("service_unavailable", 503);
  if (!data) throw new AppError("game_taken", 409);
  return json({ game: data });
}

async function createBotGame(supabase, user, body) {
  const level = Number(body.botLevel);
  const bot = BOT_LEVELS.get(level);
  if (!bot) throw new AppError("invalid_input");
  const humanColor = resolveColor(body.color);
  const profile = await ensureProfile(supabase, user);
  requireNamed(profile);
  const row = {
    id: crypto.randomUUID(),
    mode: "bot",
    status: "active",
    creator_id: user.user_id,
    white_id: humanColor === "w" ? user.user_id : null,
    black_id: humanColor === "b" ? user.user_id : null,
    white_name: humanColor === "w" ? profile.display_name : `${bot.name} (${bot.elo})`,
    black_name: humanColor === "b" ? profile.display_name : `${bot.name} (${bot.elo})`,
    white_picture: humanColor === "w" ? profile.picture : "",
    black_picture: humanColor === "b" ? profile.picture : "",
    bot_level: level,
    bot_side: humanColor === "w" ? "b" : "w",
    moves: [],
    move_count: 0,
    initial_time_ms: 0,
    last_move_at: now(),
    created_at: now(),
    updated_at: now(),
  };
  const { data, error } = await supabase.from(GAMES).insert(row).select("*").single();
  if (error || !data) throw new AppError("service_unavailable", 503);
  return json({ game: data });
}

function replay(row) {
  const chess = new Chess();
  for (const record of row.moves ?? []) {
    chess.move(record.s);
  }
  return chess;
}

async function submitMove(supabase, user, body) {
  const gameId = body.gameId;
  const uci = body.uci;
  const expectedPly = Number(body.expectedPly);
  if (typeof gameId !== "string" || !UUID.test(gameId)) throw new AppError("invalid_input");
  if (typeof uci !== "string" || !UCI.test(uci)) throw new AppError("invalid_input");
  if (!Number.isSafeInteger(expectedPly) || expectedPly < 0 || expectedPly > 500) throw new AppError("invalid_input");

  const game = await fetchGame(supabase, gameId);
  if (!game) throw new AppError("not_found", 404);
  if (game.status === "finished") throw new AppError("game_over", 409);
  if (game.status !== "active") throw new AppError("game_over", 409);
  if (game.move_count !== expectedPly) throw new AppError("version_conflict", 409);

  const isWhite = game.white_id === user.user_id;
  const isBlack = game.black_id === user.user_id;
  if (game.mode === "online") {
    if (!isWhite && !isBlack) throw new AppError("not_found", 404);
  } else if (game.creator_id !== user.user_id) {
    throw new AppError("not_found", 404);
  }

  const chess = replay(game);
  const turn = chess.turn();
  if (game.mode === "online" && ((turn === "w" && !isWhite) || (turn === "b" && !isBlack))) {
    throw new AppError("not_your_turn", 409);
  }

  let move;
  try {
    move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
  } catch {
    throw new AppError("illegal_move", 409);
  }
  if (move === null) throw new AppError("illegal_move", 409);

  const timestamp = now();
  const moves = [...(game.moves ?? []), { u: uci, s: move.san }];
  const update = {
    moves,
    move_count: moves.length,
    last_move_at: timestamp,
    updated_at: timestamp,
    draw_offered_by: null,
  };

  if (game.mode === "online" && game.white_time_ms !== null) {
    const lastMs = game.last_move_at ? Date.parse(game.last_move_at) : Date.parse(game.created_at);
    const elapsed = Math.max(0, Date.now() - lastMs);
    if (turn === "w") update.white_time_ms = Math.max(0, game.white_time_ms - elapsed);
    else update.black_time_ms = Math.max(0, game.black_time_ms - elapsed);
  }

  const { data: updated, error } = await supabase
    .from(GAMES)
    .update(update)
    .eq("id", gameId)
    .eq("move_count", expectedPly)
    .eq("status", "active")
    .select("*")
    .maybeSingle();
  if (error) throw new AppError("service_unavailable", 503);
  if (!updated) throw new AppError("version_conflict", 409);

  let result = updated;
  if (chess.isCheckmate()) {
    result = await finishGame(supabase, updated, {
      result: turn === "w" ? "1-0" : "0-1",
      termination: "checkmate",
      winnerId: turn === "w" ? updated.white_id : updated.black_id,
    });
  } else if (chess.isGameOver()) {
    const termination = chess.isStalemate() ? "stalemate"
      : chess.isInsufficientMaterial() ? "insufficient"
      : chess.isThreefoldRepetition() ? "threefold"
      : "fifty";
    result = await finishGame(supabase, updated, { result: "1/2-1/2", termination, winnerId: null });
  }
  return json({ game: result });
}

async function resignGame(supabase, user, body) {
  const gameId = body.gameId;
  if (typeof gameId !== "string" || !UUID.test(gameId)) throw new AppError("invalid_input");
  const game = await fetchGame(supabase, gameId);
  if (!game) throw new AppError("not_found", 404);
  const isWhite = game.white_id === user.user_id;
  const isBlack = game.black_id === user.user_id;
  if (!isWhite && !isBlack) throw new AppError("not_found", 404);
  if (game.status !== "active") throw new AppError("game_over", 409);
  const result = await finishGame(supabase, game, {
    result: isWhite ? "0-1" : "1-0",
    termination: "resign",
    winnerId: isWhite ? game.black_id : game.white_id,
  });
  return json({ game: result });
}

async function drawAction(supabase, user, body) {
  const gameId = body.gameId;
  const decision = body.decision;
  if (typeof gameId !== "string" || !UUID.test(gameId)) throw new AppError("invalid_input");
  if (decision !== "offer" && decision !== "accept" && decision !== "decline") throw new AppError("invalid_input");
  const game = await fetchGame(supabase, gameId);
  if (!game) throw new AppError("not_found", 404);
  const isWhite = game.white_id === user.user_id;
  const isBlack = game.black_id === user.user_id;
  if (!isWhite && !isBlack) throw new AppError("not_found", 404);
  if (game.status !== "active") throw new AppError("game_over", 409);

  if (decision === "accept") {
    if (!game.draw_offered_by || game.draw_offered_by === user.user_id) throw new AppError("invalid_input");
    const result = await finishGame(supabase, game, { result: "1/2-1/2", termination: "agreement", winnerId: null });
    return json({ game: result });
  }
  if (decision === "decline") {
    if (!game.draw_offered_by || game.draw_offered_by === user.user_id) throw new AppError("invalid_input");
    const { data, error } = await supabase
      .from(GAMES)
      .update({ draw_offered_by: null, updated_at: now() })
      .eq("id", gameId)
      .eq("status", "active")
      .select("*")
      .maybeSingle();
    if (error || !data) throw new AppError("service_unavailable", 503);
    return json({ game: data });
  }
  // Offer: if the opponent already offered, treat as acceptance.
  if (game.draw_offered_by && game.draw_offered_by !== user.user_id) {
    const result = await finishGame(supabase, game, { result: "1/2-1/2", termination: "agreement", winnerId: null });
    return json({ game: result });
  }
  const { data, error } = await supabase
    .from(GAMES)
    .update({ draw_offered_by: user.user_id, updated_at: now() })
    .eq("id", gameId)
    .eq("status", "active")
    .select("*")
    .maybeSingle();
  if (error || !data) throw new AppError("service_unavailable", 503);
  return json({ game: data });
}

async function cancelChallenge(supabase, user, body) {
  const gameId = body.gameId;
  if (typeof gameId !== "string" || !UUID.test(gameId)) throw new AppError("invalid_input");
  const game = await fetchGame(supabase, gameId);
  if (!game) throw new AppError("not_found", 404);
  if (game.creator_id !== user.user_id) throw new AppError("not_found", 404);
  if (game.status !== "waiting") throw new AppError("game_over", 409);
  const result = await finishGame(supabase, game, { result: null, termination: "aborted", winnerId: null });
  return json({ game: result });
}

async function gameState(supabase, user, body) {
  const gameId = body.gameId;
  if (typeof gameId !== "string" || !UUID.test(gameId)) throw new AppError("invalid_input");
  const game = await fetchGame(supabase, gameId);
  if (!game) throw new AppError("not_found", 404);
  if (game.status !== "active") return json({ game });
  const isPlayer = game.white_id === user.user_id || game.black_id === user.user_id;
  if (isPlayer && game.mode === "online" && game.white_time_ms !== null) {
    const timedOut = await checkTimeout(supabase, game);
    return json({ game: timedOut });
  }
  return json({ game });
}

async function checkTimeout(supabase, game) {
  const chess = replay(game);
  const turn = chess.turn();
  const lastMs = game.last_move_at ? Date.parse(game.last_move_at) : Date.parse(game.created_at);
  const remaining = (turn === "w" ? game.white_time_ms : game.black_time_ms) - (Date.now() - lastMs);
  if (remaining > 0) return game;
  return await finishGame(supabase, game, {
    result: turn === "w" ? "0-1" : "1-0",
    termination: "timeout",
    winnerId: turn === "w" ? game.black_id : game.white_id,
  });
}

async function finishGame(supabase, game, { result, termination, winnerId }) {
  if (!TERMINATIONS.has(termination)) throw new AppError("invalid_input");
  const { data, error } = await supabase
    .from(GAMES)
    .update({ status: "finished", result, termination, winner_id: winnerId, draw_offered_by: null, updated_at: now() })
    .eq("id", game.id)
    .eq("status", game.status)
    .select("*")
    .maybeSingle();
  if (error) throw new AppError("service_unavailable", 503);
  if (!data) {
    // Another request finalized first; return the persisted state.
    const current = await fetchGame(supabase, game.id);
    return current ?? game;
  }
  try {
    await applyOutcome(supabase, data);
  } catch {
    // The result row is authoritative; rating/stats updates are best-effort.
  }
  return data;
}

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

async function applyOutcome(supabase, game) {
  if (!game.result) return;
  if (game.mode === "bot") {
    const humanId = game.bot_side === "w" ? game.black_id : game.white_id;
    if (!humanId) return;
    const humanWon = (game.result === "1-0" && game.white_id === humanId) || (game.result === "0-1" && game.black_id === humanId);
    const isDraw = game.result === "1/2-1/2";
    const column = humanWon ? "bot_wins" : isDraw ? "bot_draws" : "bot_losses";
    const { data } = await supabase.from(PROFILES).select("*").eq("user_id", humanId).maybeSingle();
    if (data) {
      await supabase
        .from(PROFILES)
        .update({ [column]: (data[column] ?? 0) + 1, updated_at: now() })
        .eq("user_id", humanId);
    }
    return;
  }
  const whiteId = game.white_id;
  const blackId = game.black_id;
  if (!whiteId || !blackId) return;
  const { data: profiles, error } = await supabase
    .from(PROFILES)
    .select("*")
    .in("user_id", [whiteId, blackId]);
  if (error || !profiles) return;
  const white = profiles.find((p) => p.user_id === whiteId);
  const black = profiles.find((p) => p.user_id === blackId);
  if (!white || !black) return;
  const whiteScore = game.result === "1-0" ? 1 : game.result === "1/2-1/2" ? 0.5 : 0;
  const K = 32;
  const whiteRating = white.rating ?? 1200;
  const blackRating = black.rating ?? 1200;
  const whiteDelta = Math.round(K * (whiteScore - expectedScore(whiteRating, blackRating)));
  const blackDelta = -whiteDelta;
  const whiteUpdate = {
    rating: Math.max(100, whiteRating + whiteDelta),
    wins: (white.wins ?? 0) + (whiteScore === 1 ? 1 : 0),
    losses: (white.losses ?? 0) + (whiteScore === 0 ? 1 : 0),
    draws: (white.draws ?? 0) + (whiteScore === 0.5 ? 1 : 0),
    updated_at: now(),
  };
  const blackUpdate = {
    rating: Math.max(100, blackRating + blackDelta),
    wins: (black.wins ?? 0) + (whiteScore === 0 ? 1 : 0),
    losses: (black.losses ?? 0) + (whiteScore === 1 ? 1 : 0),
    draws: (black.draws ?? 0) + (whiteScore === 0.5 ? 1 : 0),
    updated_at: now(),
  };
  await supabase.from(PROFILES).update(whiteUpdate).eq("user_id", whiteId);
  await supabase.from(PROFILES).update(blackUpdate).eq("user_id", blackId);
}

async function saveAnalysis(supabase, user, body) {
  const gameId = body.gameId;
  const analysis = body.analysis;
  if (typeof gameId !== "string" || !UUID.test(gameId)) throw new AppError("invalid_input");
  if (!analysis || typeof analysis !== "object") throw new AppError("invalid_input");
  const game = await fetchGame(supabase, gameId);
  if (!game) throw new AppError("not_found", 404);
  if (game.white_id !== user.user_id && game.black_id !== user.user_id) throw new AppError("not_found", 404);
  if (game.status !== "finished") throw new AppError("invalid_input");
  if (!Array.isArray(analysis.plies) || analysis.plies.length !== game.move_count) throw new AppError("invalid_input");
  if (typeof analysis.accuracyWhite !== "number" || typeof analysis.accuracyBlack !== "number"
    || analysis.accuracyWhite < 0 || analysis.accuracyWhite > 100
    || analysis.accuracyBlack < 0 || analysis.accuracyBlack > 100) throw new AppError("invalid_input");
  const opening = analysis.openingName;
  if (opening !== null && (typeof opening !== "string" || opening.length > 80)) throw new AppError("invalid_input");
  const plies = [];
  for (const ply of analysis.plies) {
    if (!ply || typeof ply !== "object") throw new AppError("invalid_input");
    if (typeof ply.san !== "string" || ply.san.length > 10) throw new AppError("invalid_input");
    if (typeof ply.uci !== "string" || ply.uci.length > 8) throw new AppError("invalid_input");
    if (ply.color !== "w" && ply.color !== "b") throw new AppError("invalid_input");
    if (typeof ply.evalBefore !== "number" || typeof ply.evalAfter !== "number") throw new AppError("invalid_input");
    if (typeof ply.classification !== "string" || !CLASSIFICATIONS.has(ply.classification)) throw new AppError("invalid_input");
    if (ply.bestUci !== null && (typeof ply.bestUci !== "string" || ply.bestUci.length > 8)) throw new AppError("invalid_input");
    if (ply.bestSan !== null && (typeof ply.bestSan !== "string" || ply.bestSan.length > 10)) throw new AppError("invalid_input");
    plies.push({
      ply: ply.ply, san: ply.san, uci: ply.uci, color: ply.color,
      evalBefore: Math.round(ply.evalBefore), evalAfter: Math.round(ply.evalAfter),
      bestUci: ply.bestUci ?? null, bestSan: ply.bestSan ?? null,
      classification: ply.classification,
    });
  }
  const { error } = await supabase
    .from(GAMES)
    .update({
      analysis: {
        accuracyWhite: analysis.accuracyWhite,
        accuracyBlack: analysis.accuracyBlack,
        openingName: opening ?? null,
        plies,
      },
    })
    .eq("id", gameId)
    .eq("status", "finished")
    .is("analysis", null);
  if (error) throw new AppError("service_unavailable", 503);
  return json({ ok: true });
}
