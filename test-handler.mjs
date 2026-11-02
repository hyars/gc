// Regression checks for functions/handler.mjs against the in-memory fake.
// Run: node dev/test-handler.mjs
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createFakeSupabase } from "./server.mjs";

const { handleChess } = await import(pathToFileURL(resolve("functions/handler.mjs")).href);

const FIXTURES = {
  A: { user_id: "fixture-a", name: "Arsen Test", picture: "", site_id: "s", host_id: "h", session_expires_at: Math.floor(Date.now() / 1000) + 3600 },
  B: { user_id: "fixture-b", name: "Bella Test", picture: "", site_id: "s", host_id: "h", session_expires_at: Math.floor(Date.now() / 1000) + 3600 },
};

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed += 1; console.log(`ok   ${name}`); }
  else { failed += 1; console.log(`FAIL ${name} ${extra}`); }
};

const GUEST_TOKEN = "g".repeat(43);
const OTHER_GUEST_TOKEN = "h".repeat(43);

async function call(who, method, action, payload, rawHeaders = null) {
  const headers = new Headers({ "content-type": "application/json" });
  if (rawHeaders) {
    for (const [key, value] of Object.entries(rawHeaders)) headers.set(key, value);
  } else if (who === "guest") {
    headers.set("x-gambit-account", GUEST_TOKEN);
  } else if (who === "other-guest") {
    headers.set("x-gambit-account", OTHER_GUEST_TOKEN);
  } else if (who !== "anonymous") {
    headers.set("x-qoder-user-context", Buffer.from(JSON.stringify(FIXTURES[who])).toString("base64url"));
  }
  const url = `http://local/functions/v1/app?action=${action}`;
  const response = await handleChess({
    request: new Request(url, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify({ action, ...(payload ?? {}) }) } : {}),
    }),
    supabase: createFakeSupabase(),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

// 1. Profile bootstrap supplies explicit defaults (no DB DEFAULT clauses).
const meA = await call("A", "GET", "me");
ok("A me 200", meA.status === 200);
ok("profile rating default 1200", meA.body?.profile?.rating === 1200, JSON.stringify(meA.body?.profile));
ok("profile counts default 0", meA.body?.profile?.wins === 0 && meA.body?.profile?.bot_losses === 0);
ok("puzzle counter default 0", meA.body?.profile?.puzzles_solved === 0);
ok("profile timestamps set", Boolean(meA.body?.profile?.created_at && meA.body?.profile?.updated_at));
ok("account starts unnamed", meA.body?.profile?.display_name === "", JSON.stringify(meA.body?.profile?.display_name));
await call("B", "GET", "me");

// 2. Anonymous rejected.
const anon = await call("anonymous", "GET", "me");
ok("anonymous me 401", anon.status === 401, String(anon.status));

// 2b. Automatic device accounts: no sign-in click, identity derived from token.
const guestMe = await call("guest", "GET", "me");
ok("guest account auto-created", guestMe.status === 200 && guestMe.body.profile.rating === 1200, JSON.stringify(guestMe.body));
ok("guest id is server-derived", guestMe.body.user.id.startsWith("guest-") && !guestMe.body.user.id.includes(GUEST_TOKEN));
const guestName = await call("guest", "POST", "update-profile", { displayName: "Guesty" });
ok("guest writes account name", guestName.status === 200 && guestName.body.profile.display_name === "Guesty");
const otherGuest = await call("other-guest", "GET", "me");
ok("different token, different account", otherGuest.body.user.id !== guestMe.body.user.id && otherGuest.body.profile.display_name === "");
const badToken = await call("anonymous", "GET", "me", undefined, { "x-gambit-account": "short" });
ok("bad device token rejected", badToken.status === 403, String(badToken.status));

// 3. Player writes the account name; server validates it.
const anonSave = await call("anonymous", "POST", "update-profile", { displayName: "Ghost" });
ok("anonymous update-profile 401", anonSave.status === 401, String(anonSave.status));
ok("empty name rejected", (await call("A", "POST", "update-profile", { displayName: "   " })).status === 400);
ok("31-char name rejected", (await call("A", "POST", "update-profile", { displayName: "a".repeat(31) })).status === 400);
ok("control char rejected", (await call("A", "POST", "update-profile", { displayName: "bad\u0007name" })).status === 400);
const savedName = await call("A", "POST", "update-profile", { displayName: "  Arsen  " });
ok("name saved and trimmed", savedName.status === 200 && savedName.body.profile.display_name === "Arsen", JSON.stringify(savedName.body));
const meAfterName = await call("A", "GET", "me");
ok("name persists", meAfterName.body.profile.display_name === "Arsen");
ok("30-char name accepted", (await call("A", "POST", "update-profile", { displayName: "x".repeat(30) })).status === 200);
await call("A", "POST", "update-profile", { displayName: "Arsen" });

// 3b. Puzzle counter: needs a written name, a sane id, and accumulates.
const puzzleUnnamed = await call("other-guest", "POST", "puzzle-solved", { puzzleId: "1-0" });
ok("unnamed puzzle-solved blocked", puzzleUnnamed.status === 400 && puzzleUnnamed.body.error === "profile_incomplete");
ok("missing puzzle id rejected", (await call("guest", "POST", "puzzle-solved", {})).status === 400);
ok("bad puzzle id rejected", (await call("guest", "POST", "puzzle-solved", { puzzleId: "../1-0" })).status === 400);
ok("anon puzzle-solved 401", (await call("anonymous", "POST", "puzzle-solved", { puzzleId: "1-0" })).status === 401);
const solved1 = await call("guest", "POST", "puzzle-solved", { puzzleId: "1-0" });
ok("puzzle counted", solved1.status === 200 && solved1.body.profile.puzzles_solved === 1, JSON.stringify(solved1.body));
const solved2 = await call("guest", "POST", "puzzle-solved", { puzzleId: "3-0" });
ok("puzzles accumulate", solved2.body.profile.puzzles_solved === 2, JSON.stringify(solved2.body));
const guestMe2 = await call("guest", "GET", "me");
ok("puzzle count persists", guestMe2.body.profile.puzzles_solved === 2);
ok("other accounts keep their own count", (await call("other-guest", "GET", "me")).body.profile.puzzles_solved === 0);

// 4. Game creation requires a written account name.
const botEarly = await call("B", "POST", "bot-game", { botLevel: 4, color: "white" });
ok("unnamed bot-game blocked", botEarly.status === 400 && botEarly.body.error === "profile_incomplete", JSON.stringify(botEarly.body));
const challengeEarly = await call("B", "POST", "challenge", { timeMs: 60000, color: "white" });
ok("unnamed challenge blocked", challengeEarly.status === 400 && challengeEarly.body.error === "profile_incomplete");
await call("B", "POST", "update-profile", { displayName: "Bella" });

// 5. Challenge + join + full game to checkmate with Elo updates.
const badTime = await call("A", "POST", "challenge", { timeMs: 12345, color: "white" });
ok("invalid time control 400", badTime.status === 400, String(badTime.status));

const challenge = await call("A", "POST", "challenge", { timeMs: 60000, color: "white" });
ok("challenge created", challenge.status === 200 && challenge.body.game.status === "waiting");
const gameId = challenge.body.game.id;

const selfJoin = await call("A", "POST", "join", { gameId });
ok("self join rejected", selfJoin.status === 400, String(selfJoin.status));
const join = await call("B", "POST", "join", { gameId });
ok("B joins", join.status === 200 && join.body.game.status === "active");
const doubleJoin = await call("B", "POST", "join", { gameId });
ok("double join 409", doubleJoin.status === 409, String(doubleJoin.status));

// Turn enforcement: black moves first.
const early = await call("B", "POST", "move", { gameId, uci: "e7e5", expectedPly: 0 });
ok("out of turn 409", early.status === 409 && early.body.error === "not_your_turn");
// Illegal move.
const illegal = await call("A", "POST", "move", { gameId, uci: "e2e5", expectedPly: 0 });
ok("illegal move 409", illegal.status === 409 && illegal.body.error === "illegal_move");

const moves = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6"];
const ucis = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6"];
let last = null;
for (let i = 0; i < moves.length; i++) {
  const who = i % 2 === 0 ? "A" : "B";
  const res = await call(who, "POST", "move", { gameId, uci: ucis[i], expectedPly: i });
  last = res;
  if (res.status !== 200) break;
}
ok("six plies played", last.status === 200 && last.body.game.move_count === 6);
const mate = await call("A", "POST", "move", { gameId, uci: "h5f7", expectedPly: 6 });
ok("checkmate finishes 1-0", mate.status === 200 && mate.body.game.status === "finished" && mate.body.game.result === "1-0" && mate.body.game.termination === "checkmate");

const afterA = await call("A", "GET", "me");
const afterB = await call("B", "GET", "me");
ok("winner rating up", afterA.body.profile.rating === 1216, String(afterA.body.profile.rating));
ok("loser rating down", afterB.body.profile.rating === 1184, String(afterB.body.profile.rating));
ok("win/loss recorded", afterA.body.profile.wins === 1 && afterB.body.profile.losses === 1);

// 6. Analysis save is write-once and validates shape.
const allSans = [...moves, "Qxf7"];
const allUcis = [...ucis, "h5f7"];
const analysis = {
  accuracyWhite: 95.5, accuracyBlack: 90.1, openingName: "Italian Game",
  plies: allSans.map((san, i) => ({
    ply: i + 1, san, uci: allUcis[i], color: i % 2 === 0 ? "w" : "b",
    evalBefore: 20, evalAfter: 25, bestUci: allUcis[i], bestSan: san, classification: "book",
  })),
};
const saved = await call("A", "POST", "save-analysis", { gameId, analysis });
ok("analysis saved", saved.status === 200, JSON.stringify(saved.body));
const reread = await call("A", "GET", "game", undefined).then(() => call("A", "GET", "game&id=" + gameId, undefined));
ok("analysis persisted", reread.body.game.analysis?.openingName === "Italian Game");
const resave = await call("A", "POST", "save-analysis", { gameId, analysis: { ...analysis, openingName: "Other" } });
ok("analysis write-once", resave.status === 200);
const reread2 = await call("A", "GET", "game&id=" + gameId, undefined);
ok("analysis unchanged after resave", reread2.body.game.analysis?.openingName === "Italian Game");
const badAnalysis = await call("A", "POST", "save-analysis", { gameId, analysis: { ...analysis, plies: analysis.plies.slice(1) } });
ok("wrong ply count rejected", badAnalysis.status === 400);

// 7. Draw flow on a fresh game.
const c2 = await call("A", "POST", "challenge", { timeMs: 60000, color: "random" });
const g2 = c2.body.game.id;
await call("B", "POST", "join", { gameId: g2 });
const offer = await call("A", "POST", "draw", { gameId: g2, decision: "offer" });
ok("draw offered", offer.status === 200 && offer.body.game.draw_offered_by === "fixture-a");
const acceptEarly = await call("A", "POST", "draw", { gameId: g2, decision: "accept" });
ok("self accept rejected", acceptEarly.status === 400);
const decline = await call("B", "POST", "draw", { gameId: g2, decision: "decline" });
ok("draw declined", decline.status === 200 && decline.body.game.draw_offered_by === null);
const offer2 = await call("B", "POST", "draw", { gameId: g2, decision: "offer" });
const accept = await call("A", "POST", "draw", { gameId: g2, decision: "accept" });
ok("draw by agreement", accept.status === 200 && accept.body.game.result === "1/2-1/2" && accept.body.game.termination === "agreement");

// 8. Move on finished game + stale expectedPly.
const afterEnd = await call("A", "POST", "move", { gameId: g2, uci: "e2e4", expectedPly: 0 });
ok("move on finished 409", afterEnd.status === 409);

// 9. Cancel waiting challenge.
const c3 = await call("A", "POST", "challenge", { timeMs: 180000, color: "black" });
const cancelled = await call("A", "POST", "cancel", { gameId: c3.body.game.id });
ok("cancel works", cancelled.status === 200 && cancelled.body.game.termination === "aborted");

// 10. Bot game with explicit defaults.
const bot = await call("A", "POST", "bot-game", { botLevel: 4, color: "white" });
ok("bot game active", bot.status === 200 && bot.body.game.status === "active");
ok("bot game move_count 0", bot.body.game.move_count === 0);
ok("bot game null clocks", bot.body.game.white_time_ms === null && bot.body.game.black_time_ms === null);
const resign = await call("A", "POST", "resign", { gameId: bot.body.game.id });
ok("bot resign 0-1", resign.status === 200 && resign.body.game.result === "0-1");
const meAfterBot = await call("A", "GET", "me");
ok("bot loss recorded", meAfterBot.body.profile.bot_losses === 1, String(meAfterBot.body.profile.bot_losses));

// 11. Lobby and pagination shape.
const lobby = await call("A", "GET", "lobby");
ok("lobby list", lobby.status === 200 && Array.isArray(lobby.body.games));
const mine = await call("A", "GET", "mygames&offset=0");
ok("mygames page", mine.status === 200 && Array.isArray(mine.body.items) && mine.body.items.length >= 3);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
