// Credentials come from the environment, never from the repository.
export const token = process.env.NPM_TOKEN ?? "";
export const registry = "https://registry.npmjs.org/";
