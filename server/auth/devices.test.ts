import { expect, test } from "bun:test";
import { deviceName, publicId } from "./devices.ts";

test("a readable name from the User-Agent", () => {
  const cases: [string, string][] = [
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1", "Safari on iPhone"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", "Safari on iPhone"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1", "Chrome on iPhone"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", "Chrome on Linux"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0", "Firefox on Mac"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15", "Safari on Mac"],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36", "Samsung Internet on Android"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Safari on iPad"],
    ["curl/8.5.0", "curl"],
    ["", "Unknown device"],
  ];
  for (const [ua, name] of cases) expect(deviceName(ua)).toBe(name);
});

test("the public id is the start of the hash, never all of it", () => {
  const hash = "a".repeat(16) + "b".repeat(48);
  expect(publicId(hash)).toBe("a".repeat(16));
});
