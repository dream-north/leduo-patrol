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

export function hasAuthorizedAccessCookie(rawCookie: string | undefined, expectedKey: string) {
  if (!expectedKey) {
    return true;
  }
  if (!rawCookie) {
    return false;
  }

  const segments = rawCookie.split(";");
  for (const segment of segments) {
    const [rawName, ...rawValueParts] = segment.trim().split("=");
    if (rawName !== "leduo_patrol_key") {
      continue;
    }

    const rawValue = rawValueParts.join("=");
    try {
      return decodeURIComponent(rawValue) === expectedKey;
    } catch {
      return rawValue === expectedKey;
    }
  }

  return false;
}

export function buildAccessCookie(expectedKey: string) {
  return `leduo_patrol_key=${encodeURIComponent(expectedKey)}; Path=/; HttpOnly; SameSite=Lax`;
}
