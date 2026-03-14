/**
 * Error enhancement for common @actual-app/api failures.
 * The API often returns opaque messages; we wrap them with actionable hints.
 */

/** Message thrown when listRemoteFiles returns null (auth/network/server error). */
const REMOTE_FILES_ERROR = "Could not get remote files";

/**
 * If the error is the opaque "Could not get remote files" from downloadBudget,
 * enhance it with troubleshooting hints. Otherwise return the original.
 */
export function enhanceDownloadError(err: unknown, serverUrl?: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes(REMOTE_FILES_ERROR) || message.includes("Common causes:")) {
    return err instanceof Error ? err : new Error(String(err));
  }

  const debugHint = serverUrl
    ? `To debug: ab-mirror list-budgets --server ${serverUrl}`
    : "To debug: run `ab-mirror list-budgets --server <url>` to verify connectivity and auth.";

  const hints: string[] = [
    "This usually means the sync server could not be reached or authentication failed.",
    "",
    "Common causes:",
    "  • Wrong or missing AB_MIRROR_SERVER_PASSWORD (if your server requires a password)",
    "  • Server URL unreachable (check config.server.url and network)",
    "  • Sync server returned an error (check server logs)",
    "  • Auth failures on @actual-app/api <26.1.0 — upgrade to 26.1.0+ if using password auth",
    "",
    debugHint,
  ];

  return new Error(`${message}\n\n${hints.join("\n")}`);
}
