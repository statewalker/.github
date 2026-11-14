// What moved between two pnpm lockfiles, for the lockfile-only pull request's description.

/** `@statewalker/*` versions in a pnpm lockfile: Map name → Set of versions. */
export function statewalkerVersions(text) {
  const map = new Map();
  for (const m of text.matchAll(/^ {2}'?(@statewalker\/[^@'\s]+)@([^'(:\s]+)/gm)) {
    if (!map.has(m[1])) map.set(m[1], new Set());
    map.get(m[1]).add(m[2]);
  }
  return map;
}

/** Markdown lines "`name`: old → new" for what moved between two lockfiles. */
export function moves(before, after) {
  const a = statewalkerVersions(before);
  const b = statewalkerVersions(after);
  const lines = [];
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const was = [...(a.get(name) ?? [])].filter((v) => !b.get(name)?.has(v));
    const now = [...(b.get(name) ?? [])].filter((v) => !a.get(name)?.has(v));
    if (was.length || now.length) lines.push(`- \`${name}\`: ${was.join(", ") || "(new)"} → ${now.join(", ") || "(removed)"}`);
  }
  return lines;
}
