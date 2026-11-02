// Generates and verifies mate puzzles for Gambit. Every emitted position is
// machine-checked: the side to move has a forced mate in exactly N plies and
// not fewer. Run: node dev/make-puzzles.mjs  (writes src/chess/puzzles.ts)
import { Chess } from "chess.js";
import { writeFileSync } from "node:fs";

const FILES = "abcdefgh";

function buildFen(pieces, side) {
  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (const p of pieces) {
    grid[p.rank][p.file] = p.color === "w" ? p.type : p.type.toLowerCase();
  }
  const rows = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const cell = grid[rank][file];
      if (!cell) empty += 1;
      else {
        if (empty) { row += empty; empty = 0; }
        row += cell;
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return `${rows.join("/")} ${side} - - 0 1`;
}

// ---- Puzzle tests -------------------------------------------------------

function mateInOne(chess) {
  for (const move of chess.moves({ verbose: true })) {
    chess.move(move);
    const mate = chess.isCheckmate();
    chess.undo();
    if (mate) return true;
  }
  return false;
}

const mateMemo = new Map();

// Mate in 2: a checking first move after which every defense is mated at once.
function mateInTwo(fen, attacker) {
  if (mateMemo.has(fen)) return mateMemo.get(fen);
  let found = false;
  const chess = new Chess(fen);
  for (const move of chess.moves({ verbose: true })) {
    chess.move(move);
    if (!chess.isCheck() || chess.isCheckmate()) { chess.undo(); continue; }
    const replies = chess.moves({ verbose: true });
    let allMated = replies.length > 0;
    for (const reply of replies) {
      chess.move(reply);
      const mated = mateInOne(chess);
      chess.undo();
      if (!mated) { allMated = false; break; }
    }
    chess.undo();
    if (allMated) { found = true; break; }
  }
  mateMemo.set(fen, found);
  return found;
}

// The side NOT to move must not already be in check, or the position is
// illegal and chess.js will happily generate "capture the king" moves.
function defenderInCheck(chess, attacker) {
  const defender = attacker === "w" ? "b" : "w";
  for (const row of chess.board()) {
    for (const square of row) {
      if (square && square.type === "k" && square.color === defender) {
        return chess.isAttacked(square.square, attacker);
      }
    }
  }
  return true;
}

function classify(fen, attacker) {
  let chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  if (chess.isCheckmate() || chess.isStalemate()) return null;
  if (chess.turn() !== attacker) return null;
  if (defenderInCheck(chess, attacker)) return null;
  if (mateInOne(chess)) return 1;
  return mateInTwo(fen, attacker) ? 3 : null;
}

// ---- Position families --------------------------------------------------

function* kqkPositions(attacker) {
  const a = attacker;
  const d = a === "w" ? "b" : "w";
  const corners = [
    { files: [0, 1, 2, 3], ranks: [0, 1, 2, 3], bk: [[0, 0], [1, 0], [0, 1], [1, 1]] },
    { files: [4, 5, 6, 7], ranks: [0, 1, 2, 3], bk: [[7, 0], [6, 0], [7, 1], [6, 1]] },
    { files: [0, 1, 2, 3], ranks: [4, 5, 6, 7], bk: [[0, 7], [1, 7], [0, 6], [1, 6]] },
    { files: [4, 5, 6, 7], ranks: [4, 5, 6, 7], bk: [[7, 7], [6, 7], [7, 6], [6, 6]] },
  ];
  for (const zone of corners) {
    for (const [bf, br] of zone.bk) {
      for (const wf of zone.files) {
        for (const wr of zone.ranks) {
          const dist = Math.max(Math.abs(wf - bf), Math.abs(wr - br));
          if (dist < 2 || dist > 3) continue;
          for (const qf of zone.files) {
            for (const qr of zone.ranks) {
              if ((qf === wf && qr === wr) || (qf === bf && qr === br)) continue;
              yield [
                { type: "K", color: a, file: wf, rank: wr },
                { type: "Q", color: a, file: qf, rank: qr },
                { type: "K", color: d, file: bf, rank: br },
              ];
            }
          }
        }
      }
    }
  }
}

function* backRankPositions(attacker) {
  const a = attacker;
  const d = a === "w" ? "b" : "w";
  const setups = attacker === "w"
    ? [
        { kf: 6, kr: 7, pawns: [[5, 6], [6, 6], [7, 6]] },
        { kf: 7, kr: 7, pawns: [[5, 6], [6, 6]] },
        { kf: 0, kr: 7, pawns: [[0, 6], [1, 6]] },
        { kf: 1, kr: 7, pawns: [[0, 6], [1, 6], [2, 6]] },
      ]
    : [
        { kf: 6, kr: 0, pawns: [[5, 1], [6, 1], [7, 1]] },
        { kf: 7, kr: 0, pawns: [[5, 1], [6, 1]] },
        { kf: 0, kr: 0, pawns: [[0, 1], [1, 1]] },
        { kf: 1, kr: 0, pawns: [[0, 1], [1, 1], [2, 1]] },
      ];
  for (const s of setups) {
    for (let rf = 0; rf < 8; rf++) {
      for (let rr = 0; rr < 8; rr++) {
        if (rf === s.kf && rr === s.kr) continue;
        if (s.pawns.some(([pf, pr]) => pf === rf && pr === rr)) continue;
        yield [
          { type: "K", color: a, file: 4, rank: attacker === "w" ? 0 : 7 },
          { type: "R", color: a, file: rf, rank: rr },
          { type: "K", color: d, file: s.kf, rank: s.kr },
          ...s.pawns.map(([pf, pr]) => ({ type: "p", color: d, file: pf, rank: pr })),
        ];
      }
    }
  }
}

// Queen sacrifice on the back rank: white Kh1, Re1, queen on any square vs
// black Kh8, Rf8, pawns g7 h7 (and the a-file mirror for black to move).
function* backRankSacPositions() {
  const black = [
    { type: "K", color: "b", file: 7, rank: 7 },
    { type: "R", color: "b", file: 5, rank: 7 },
    { type: "p", color: "b", file: 6, rank: 6 },
    { type: "p", color: "b", file: 7, rank: 6 },
  ];
  const white = [
    { type: "K", color: "w", file: 7, rank: 0 },
    { type: "R", color: "w", file: 4, rank: 0 },
  ];
  const occupied = new Set(["h8", "f8", "g7", "h7", "h1", "e1"]);
  for (let qf = 0; qf < 8; qf++) {
    for (let qr = 0; qr < 8; qr++) {
      const square = FILES[qf] + (qr + 1);
      if (occupied.has(square)) continue;
      yield [...white, ...black, { type: "Q", color: "w", file: qf, rank: qr }];
    }
  }
}

// Hand-picked classic mates; each is still machine-verified below.
const CLASSICS = [
  "5r1k/6pp/7N/8/8/1Q6/8/7K w - - 0 1", // Lucena: Qg8+! Rxg8 Nf7#
];

// ---- Collection ---------------------------------------------------------

const seen = new Set();
const buckets = new Map([[1, []], [3, []]]);
const caps = { 1: 10, 3: 10 };

function push(found) {
  if (seen.has(found.fen)) return;
  const bucket = buckets.get(found.maxPlies);
  if (!bucket || bucket.length >= caps[found.maxPlies]) return;
  seen.add(found.fen);
  bucket.push(found);
}

function collect(name, fenPositions, attacker, theme) {
  let scanned = 0;
  const started = Date.now();
  const matches = { 1: [], 3: [] };
  for (const fen of fenPositions) {
    if (Date.now() - started > 45000) break; // keep generation bounded
    scanned += 1;
    const exact = classify(fen, attacker);
    if (exact === null) continue;
    if (matches[exact].length < Math.max(caps[exact], 40)) matches[exact].push(fen);
  }
  // Spread picks across the family so puzzles are not near-identical clones,
  // and keep any one family from flooding a tier.
  const perFamily = { 1: 4, 3: 6 };
  for (const plies of [1, 3]) {
    const pool = matches[plies].filter((fen) => !seen.has(fen));
    const room = Math.min(caps[plies] - buckets.get(plies).length, perFamily[plies]);
    const take = Math.min(room, pool.length);
    const stride = take > 0 ? Math.max(1, Math.floor(pool.length / take)) : 1;
    for (let i = 0, picked = 0; picked < take && i < pool.length; i += stride, picked += 1) {
      push({ fen: pool[i], side: attacker, attacker, maxPlies: plies, theme });
    }
  }
  console.log(`${name}: scanned ${scanned}, buckets ${[...buckets.entries()].map(([k, v]) => `${k}ply=${v.length}`).join(" ")}`);
}

const fensOf = (piecesList, side) => piecesList.map((pieces) => buildFen(pieces, side));

// Best puzzles first — caps mean later families may not contribute.
collect("Classic mates", CLASSICS, "w", "Classic");
collect("Back-rank sacrifice (white)", fensOf(backRankSacPositions(), "w"), "w", "Back-rank sacrifice");
collect("K+Q net (white)", fensOf(kqkPositions("w"), "w"), "w", "Queen net");
collect("K+Q net (black)", fensOf(kqkPositions("b"), "b"), "b", "Queen net");
collect("Back rank mate-in-1 (white)", fensOf(backRankPositions("w"), "w"), "w", "Back rank");
collect("Back rank mate-in-1 (black)", fensOf(backRankPositions("b"), "b"), "b", "Back rank");

const puzzles = [];
const themeNames = { 1: "Mate in 1", 3: "Mate in 2" };
for (const [plies, list] of buckets) {
  list.forEach((p, i) => {
    puzzles.push({ id: `${plies}-${i}`, fen: p.fen, side: p.side, theme: `${p.theme} · ${themeNames[plies]}`, maxPlies: plies });
  });
}

// Final verification pass over the emitted set.
for (const puzzle of puzzles) {
  const exact = classify(puzzle.fen, puzzle.side);
  if (exact !== puzzle.maxPlies) throw new Error(`Puzzle ${puzzle.id} failed verification (${exact})`);
}

const output = `// Generated by dev/make-puzzles.mjs — every position machine-verified
// (forced mate in exactly maxPlies plies, not fewer).
export type Puzzle = {
  id: string;
  fen: string;
  side: "w" | "b";
  theme: string;
  maxPlies: number;
};

export const PUZZLES: Puzzle[] = ${JSON.stringify(puzzles, null, 2)};
`;
writeFileSync(new URL("../src/chess/puzzles.ts", import.meta.url), output);
console.log(`\nWrote ${puzzles.length} puzzles to src/chess/puzzles.ts`);
