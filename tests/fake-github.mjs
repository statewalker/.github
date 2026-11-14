// A stand-in for the GitHub REST API: routes given per test as
// { "GET /repos/o/r/pulls/1": (req) => [status, body] | body }, matched on the path without the
// query string. Records every request; an unknown route answers 404.
import { spawn } from "node:child_process";
import http from "node:http";

export async function fakeGitHub(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      const pathname = decodeURIComponent(url.pathname);
      const request = { method: req.method, path: pathname, query: url.searchParams, json: body ? JSON.parse(body) : undefined, auth: req.headers.authorization };
      requests.push(request);
      const handler = routes[`${req.method} ${pathname}`];
      let result = handler ? (typeof handler === "function" ? handler(request) : handler) : [404, { message: "Not Found" }];
      if (!Array.isArray(result) || typeof result[0] !== "number") result = [200, result];
      res.writeHead(result[0], { "content-type": "application/json" });
      res.end(JSON.stringify(result[1]));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    writes: () => requests.filter((r) => r.method !== "GET"),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Run a script as a separate process (async, so the fake server in this process can answer). */
export function run(script, args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}
