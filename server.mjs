// Development only: synthetic identities and volatile records, never deploy.
// Runs the real function handler with an in-memory fake Supabase client.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { handleChess } = await import(pathToFileURL(resolve(process.argv[2] ?? "functions/handler.mjs")).href);
const PORT = Number(process.argv[3] ?? 8000);

const tables = { profiles: new Map(), games: new Map() };

export function createFakeSupabase() {
  return { from: (table) => makeBuilder(table) };
}

const DEFAULTS = {
  profiles: { rating: 1200, wins: 0, losses: 0, draws: 0, bot_wins: 0, bot_losses: 0, bot_draws: 0, puzzles_solved: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  games: { moves: [], move_count: 0, draw_offered_by: null, white_time_ms: null, black_time_ms: null, initial_time_ms: 0, analysis: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
};

function matches(row, filters) {
  for (const filter of filters) {
    if (filter.kind === "eq" && row[filter.column] !== filter.value) return false;
    if (filter.kind === "is" && row[filter.column] !== filter.value) return false;
    if (filter.kind === "in" && !filter.values.includes(row[filter.column])) return false;
    if (filter.kind === "or") {
      const ok = filter.parts.some((part) => row[part.column] === part.value);
      if (!ok) return false;
    }
  }
  return true;
}

function makeBuilder(table) {
  const state = { table, op: null, payload: null, filters: [], orders: [], limit: Infinity, range: null, single: false, selected: false };
  const rows = () => [...tables[state.table].values()];
  const apply = () => {
    if (state.op === "insert") {
      const list = Array.isArray(state.payload) ? state.payload : [state.payload];
      for (const row of list) tables[state.table].set(row.id ?? row.user_id, structuredClone({ ...DEFAULTS[state.table], ...row }));
      return list.map((row) => structuredClone(tables[state.table].get(row.id ?? row.user_id)));
    }
    if (state.op === "upsert") {
      const list = Array.isArray(state.payload) ? state.payload : [state.payload];
      const key = (row) => row.id ?? row.user_id;
      for (const row of list) {
        if (!tables[state.table].has(key(row))) tables[state.table].set(key(row), structuredClone({ ...DEFAULTS[state.table], ...row }));
      }
      return list.map((row) => structuredClone(tables[state.table].get(key(row))));
    }
    let list = rows().filter((row) => matches(row, state.filters));
    for (const [column, direction] of state.orders) {
      list.sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (direction === "desc" ? -1 : 1));
    }
    if (state.op === "update") {
      const updated = [];
      for (const row of list) {
        Object.assign(tables[state.table].get(row.id ?? row.user_id), structuredClone(state.payload));
        updated.push(structuredClone(tables[state.table].get(row.id ?? row.user_id)));
      }
      list = updated;
    }
    if (state.range) list = list.slice(state.range[0], state.range[1] + 1);
    if (state.limit !== Infinity) list = list.slice(0, state.limit);
    return list.map((row) => structuredClone(row));
  };
  const builder = {
    select() { state.selected = true; return builder; },
    insert(payload) { state.op = "insert"; state.payload = payload; return builder; },
    upsert(payload) { state.op = "upsert"; state.payload = payload; return builder; },
    update(payload) { state.op = "update"; state.payload = payload; return builder; },
    eq(column, value) { state.filters.push({ kind: "eq", column, value }); return builder; },
    is(column, value) { state.filters.push({ kind: "is", column, value }); return builder; },
    in(column, values) { state.filters.push({ kind: "in", column, values }); return builder; },
    or(expression) {
      const parts = expression.split(",").map((part) => {
        const [column, , value] = part.split(".");
        return { column, value };
      });
      state.filters.push({ kind: "or", parts });
      return builder;
    },
    order(column, options) { state.orders.push([column, options?.ascending === false ? "desc" : "asc"]); return builder; },
    limit(value) { state.limit = value; return builder; },
    range(start, end) { state.range = [start, end]; return builder; },
    maybeSingle() { return { data: apply()[0] ?? null, error: null }; },
    single() {
      const list = apply();
      if (!list.length) return { data: null, error: { message: "no rows" } };
      return { data: list[0], error: null };
    },
    then(resolve, reject) {
      try {
        const rows = apply();
        resolve({ data: state.selected ? rows : null, error: null });
      } catch (error) {
        reject(error);
      }
    },
  };
  return builder;
}

const FIXTURES = {
  A: { user_id: "fixture-a", name: "Arsen Test", picture: "", site_id: "s", host_id: "h", session_expires_at: Math.floor(Date.now() / 1000) + 3600 },
  B: { user_id: "fixture-b", name: "Bella Test", picture: "", site_id: "s", host_id: "h", session_expires_at: Math.floor(Date.now() / 1000) + 3600 },
};

const isMain = process.argv[1]?.replaceAll("\\", "/").endsWith("dev/server.mjs");
if (isMain) createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, `http://127.0.0.1:${PORT}`);
    if (!url.pathname.startsWith("/functions/v1/app")) {
      outgoing.writeHead(404);
      outgoing.end();
      return;
    }
    const fixture = url.searchParams.get("fixture");
    if (fixture && ["A", "B", "anonymous"].includes(fixture) && incoming.method === "GET") {
      outgoing.writeHead(200, { "set-cookie": `sites_fixture=${fixture}; Path=/; SameSite=Strict`, "content-type": "text/plain" });
      outgoing.end(`Local fixture: ${fixture}. Return to the page and reload.`);
      return;
    }
    const who = /(?:^|;\s*)sites_fixture=(A|B|anonymous)(?:;|$)/.exec(incoming.headers.cookie ?? "")?.[1] ?? null;
    const headers = new Headers({ "content-type": incoming.headers["content-type"] ?? "" });
    if (who === "A" || who === "B") {
      headers.set("x-qoder-user-context", Buffer.from(JSON.stringify(FIXTURES[who])).toString("base64url"));
    } else if (who === null) {
      // No fixture cookie: behave like production for device accounts.
      const token = incoming.headers["x-gambit-account"];
      if (typeof token === "string") headers.set("x-gambit-account", token);
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 300000) { outgoing.writeHead(413); outgoing.end(); return; }
      chunks.push(chunk);
    }
    const response = await handleChess({
      request: new Request(url, {
        method: incoming.method,
        headers,
        ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      }),
      supabase: createFakeSupabase(),
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500);
    outgoing.end("Local fixture failure");
  }
}).listen(PORT, "127.0.0.1", function () {
  console.log(`Local chess API: http://127.0.0.1:${this.address().port}/functions/v1/app?action=me (fixture cookie: ?fixture=A|B|anonymous)`);
});
