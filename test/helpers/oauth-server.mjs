import http from "node:http";

/**
 * A local stand-in for the Dropbox token endpoint. Records every request
 * (method, headers, parsed form body) and answers with a configurable
 * response. Default: a valid refresh response.
 */
export async function startTokenServer(t, options = {}) {
  const state = {
    requests: [],
    respond: options.respond ?? (() => ({ status: 200, body: { access_token: `sl.test-${Date.now()}`, token_type: "bearer", expires_in: 14400 } })),
    delayMs: options.delayMs ?? 0,
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const record = { method: req.method, url: req.url, headers: req.headers, form: Object.fromEntries(new URLSearchParams(raw)) };
      state.requests.push(record);
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      const reply = await state.respond(record, state.requests.length);
      const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
      res.writeHead(reply.status ?? 200, { "content-type": reply.contentType ?? "application/json" });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  state.url = `http://127.0.0.1:${port}/oauth2/token`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return state;
}

/** A fetch that talks to the local token server, for in-process tests. */
export function fetchTo(serverState) {
  return (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url !== "https://api.dropboxapi.com/oauth2/token") throw new Error(`unexpected fetch to ${url}`);
    return globalThis.fetch(serverState.url, init);
  };
}
