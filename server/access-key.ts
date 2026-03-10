import { randomBytes } from "node:crypto";

export function createAccessKey() {
  return randomBytes(24).toString("hex");
}

export function isAccessKeyAuthorized(rawUrl: string | undefined, expectedKey: string) {
  if (!expectedKey) {
    return true;
  }
  if (!rawUrl) {
    return false;
  }

  const parsedUrl = new URL(rawUrl, "http://localhost");
  return parsedUrl.searchParams.get("key") === expectedKey;
}
