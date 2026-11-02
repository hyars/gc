// Independent check of the generated puzzles against the runtime solver.
// Run: node --experimental-strip-types dev/verify-puzzles.mjs
import { Chess } from "chess.js";
import { forcedMateWithin, shortestMate, delayingReply } from "../src/chess/puzzleSolver.ts";
import { PUZZLES } from "../src/chess/puzzles.ts";

let failures = 0;

for (const puzzle of PUZZLES) {
  const { fen, side, maxPlies, id } = puzzle;
  const chess = new Chess(fen);
  const problem = [];
  if (chess.turn() !== side) problem.push("wrong side to move");
  if (chess.isCheckmate() || chess.isStalemate()) problem.push("position already over");
  const defender = side === "w" ? "b" : "w";
  for (const row of chess.board()) {
    for (const square of row) {
      if (square && square.type === "k" && square.color === defender && chess.isAttacked(square.square, side)) {
        problem.push("defender already in check");
      }
    }
  }
  if (!forcedMateWithin(fen, side, maxPlies)) problem.push(`no forced mate within ${maxPlies} plies`);
  if (maxPlies > 1 && forcedMateWithin(fen, side, maxPlies - 2)) problem.push(`mate in ${maxPlies - 2} plies is faster`);
  if (shortestMate(fen, side, 7) !== maxPlies) problem.push(`shortestMate=${shortestMate(fen, side, 7)}`);

  // A solver move must survive the opponent's toughest defense.
  let solvedLine = null;
  for (const move of chess.moves({ verbose: true })) {
    chess.move(move);
    const after = chess.fen();
    const wins = chess.isCheckmate() || forcedMateWithin(after, side, maxPlies - 1);
    chess.undo();
    if (!wins) continue;
    chess.move(move);
    const reply = chess.isCheckmate() ? null : delayingReply(chess.fen(), side, maxPlies - 1);
    chess.undo();
    solvedLine = `${move.san}${reply ? ` ${reply.from}${reply.to}` : "#"}`;
    break;
  }
  if (!solvedLine) problem.push("no winning first move found");

  if (problem.length) {
    failures += 1;
    console.log(`FAIL ${id} (${puzzle.theme}) ${fen}: ${problem.join("; ")}`);
  } else {
    console.log(`ok   ${id} ${maxPlies}pl ${puzzle.theme}: ${solvedLine}`);
  }
}

console.log(`\n${PUZZLES.length - failures}/${PUZZLES.length} puzzles verified`);
if (failures) process.exit(1);
