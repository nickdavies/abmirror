/**
 * Provider-specific message limits. Used to truncate reports before sending
 * to avoid rejection (e.g. Pushover 1,024 char limit). Reusable by any provider.
 */
export const PROVIDER_LIMITS = {
  pushover: { title: 250, message: 1024 },
  default: { title: 500, message: 4096 },
} as const;

const TRUNCATE_SUFFIX = "\n... (truncated, see logs for full report)";

export type ProviderKey = keyof typeof PROVIDER_LIMITS;

export function truncateForProvider(
  title: string,
  message: string,
  provider: ProviderKey = "default"
): { title: string; message: string } {
  const { title: maxTitle, message: maxMsg } = PROVIDER_LIMITS[provider];
  const truncatedTitle =
    title.length > maxTitle ? title.slice(0, maxTitle - 3) + "..." : title;
  const truncatedMsg =
    message.length > maxMsg
      ? message.slice(0, maxMsg - TRUNCATE_SUFFIX.length) + TRUNCATE_SUFFIX
      : message;
  return { title: truncatedTitle, message: truncatedMsg };
}
