/**
 * list-budgets: List sync IDs and budget names for a given Actual sync server.
 * Helps discover sync IDs when setting up config (e.g. after creating a budget in the web UI).
 */
import { mkdirSync } from "fs";
import * as actual from "@actual-app/api";
import read from "read";

type LoginMethod = { method: string; displayName: string; active: number };
type LoginMethodsResponse = { status: string; methods?: LoginMethod[] };

function loginMethodsUrl(serverUrl: string): string {
  const base = serverUrl.replace(/\/$/, "");
  return `${base}/account/login-methods`;
}

async function fetchLoginMethods(serverUrl: string): Promise<LoginMethodsResponse> {
  const url = loginMethodsUrl(serverUrl);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch login methods: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as LoginMethodsResponse;
}

/** Password auth is available if password is in the methods list (active = default only). */
function isPasswordAuthAvailable(methods: LoginMethod[]): boolean {
  return methods.some((m) => m.method === "password");
}

/** OpenID-only: password is not configured at all. */
function isOpenIdOnly(methods: LoginMethod[]): boolean {
  return !methods.some((m) => m.method === "password");
}

/**
 * Resolves server password: checks if password auth is required, returns from env
 * or prompts via stdin. Exits with clear error for OpenID-only or non-TTY without env.
 */
export async function resolvePassword(serverUrl: string): Promise<string> {
  const envPassword = process.env["AB_MIRROR_SERVER_PASSWORD"];

  let methods: LoginMethod[];
  try {
    const data = await fetchLoginMethods(serverUrl);
    methods = data.methods ?? [];
  } catch (err) {
    console.error(`Could not reach server: ${String(err)}`);
    process.exit(1);
  }

  if (methods.length === 0) {
    return envPassword ?? "";
  }

  if (isOpenIdOnly(methods)) {
    console.error(
      "Server uses OpenID authentication. This command cannot authenticate interactively.",
    );
    console.error("Use a session token or configure password authentication on the server.");
    process.exit(1);
  }

  if (!isPasswordAuthAvailable(methods)) {
    return envPassword ?? "";
  }

  if (envPassword !== undefined && envPassword !== "") {
    return envPassword;
  }

  if (!process.stdin.isTTY) {
    console.error("Server requires a password. Set AB_MIRROR_SERVER_PASSWORD or run with a TTY.");
    process.exit(1);
  }

  const password = await new Promise<string>((resolve, reject) => {
    read(
      { prompt: "Server password: ", silent: true, replace: "*" },
      (err, result) => {
        if (err) reject(err);
        else resolve(result ?? "");
      }
    );
  });
  return password;
}

export interface ListBudgetsOptions {
  serverUrl: string;
  dataDir: string;
  password: string;
  verbose?: boolean;
}

export async function runListBudgets(opts: ListBudgetsOptions): Promise<void> {
  const { serverUrl, dataDir, password, verbose = false } = opts;

  mkdirSync(dataDir, { recursive: true });

  await actual.init({
    dataDir,
    serverURL: serverUrl,
    password,
    verbose,
  });

  try {
    const budgets = await actual.getBudgets();

    console.log(`Server: ${serverUrl}`);
    console.log("---");

    for (const b of budgets) {
      const syncId = (b as { groupId?: string }).groupId ?? "(no sync id)";
      const name = (b as { name?: string }).name ?? "(no name)";
      const encryptKeyId = (b as { encryptKeyId?: string }).encryptKeyId;
      const state = (b as { state?: string }).state;

      const suffix = encryptKeyId ? " (encrypted)" : state === "remote" ? "" : " (local)";
      console.log(`  ${syncId}\t${name}${suffix}`);
    }
  } finally {
    await actual.shutdown();
  }
}
