import { expect, test } from "bun:test";
import { resetsIn } from "./Usage.tsx";

test("reset times read naturally", () => {
  const now = new Date(2026, 9, 8, 15, 0).getTime();
  expect(resetsIn(now + 25 * 60_000, now)).toBe("en 25 min");
  expect(resetsIn(now + (2 * 60 + 14) * 60_000, now)).toBe("en 2 h 14 min");
  expect(resetsIn(new Date(2026, 9, 12, 17, 0).getTime(), now)).toMatch(/^el lunes a las 17:00$/);
  expect(resetsIn(now - 1000, now)).toBe("en 0 min");
});
