/**
 * How a sign-in is shown in the devices list: a name from its User-Agent ("Chrome on Linux",
 * "Safari on iPhone") and a short public id. The id is the start of the token's hash: enough to
 * pick one sign-in, while the full hash (what sessions.json keeps) never leaves the server.
 */
export const PUBLIC_ID_LENGTH = 16;

export function publicId(idHash: string): string {
  return idHash.slice(0, PUBLIC_ID_LENGTH);
}

export function deviceName(userAgent: string): string {
  const ua = userAgent;
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(ua)
            ? "Mac"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  // order matters: Edge and Opera say Chrome too, Chrome says Safari, iOS browsers all are Safari underneath
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser\//.test(ua)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS\//.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua) || /AppleWebKit/.test(ua)
              ? "Safari"
              : /^curl\//.test(ua)
                ? "curl"
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}
