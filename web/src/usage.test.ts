import { expect, test } from "bun:test";
import { resetsIn } from "./Usage.tsx";

test("reset times read naturally", () => {
  const now = new Date(2026, 9, 8, 15, 0).getTime();
  expect(resetsIn(now + 25 * 60_000, now)).toBe("in 25 min");
  expect(resetsIn(now + (2 * 60 + 14) * 60_000, now)).toBe("in 2 h 14 min");
  expect(resetsIn(new Date(2026, 9, 12, 17, 0).getTime(), now)).toMatch(/^on Monday at 5:00\sPM$/);
  expect(resetsIn(now - 1000, now)).toBe("in 0 min");
});
