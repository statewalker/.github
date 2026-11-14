// A minimal GitHub REST client for the CI scripts. No dependencies: Node's fetch.
// GITHUB_API_URL (set by GitHub Actions; the tests point it at a fake server) defaults to
// https://api.github.com.

/**
 * A client authenticated with `token`. `call(method, path, body, accept)` returns the parsed body;
 * statuses in `accept` besides 2xx are returned as `{ httpStatus, ...body }`, others throw.
 * `pages(path, key)` reads every page of a list (`key` names the array in an object response,
 * such as `repositories` or `check_runs`).
 */
export function rest(token, api = process.env.GITHUB_API_URL || "https://api.github.com") {
  const base = api.replace(/\/$/, "");
  async function call(method, route, body, accept = []) {
    const res = await fetch(route.startsWith("http") ? route : `${base}${route}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }
    if (!res.ok && !accept.includes(res.status)) {
      throw new Error(`${method} ${route}: HTTP ${res.status} ${data.message ?? ""}`.trim());
    }
    return Array.isArray(data) ? data : { httpStatus: res.status, ...data };
  }
  async function pages(route, key) {
    const out = [];
    for (let page = 1; ; page++) {
      const sep = route.includes("?") ? "&" : "?";
      const data = await call("GET", `${route}${sep}per_page=100&page=${page}`);
      const items = key ? (data[key] ?? []) : data;
      out.push(...items);
      if (items.length < 100) return out;
    }
  }
  return { call, pages };
}
