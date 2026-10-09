import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrClient } from "./client.ts";

let server: ReturnType<typeof Bun.listen> | null = null;
afterEach(() => server?.stop(true));

test("a refused subscription reports its close once", async () => {
  const path = join(tmpdir(), `herdr-test-${process.pid}-${Date.now()}.sock`);
  server = Bun.listen({
    unix: path,
    socket: {
      data(socket) {
        socket.write(JSON.stringify({ id: "sub_1", error: { code: "invalid_request", message: "nope" } }) + "\n");
        socket.end();
      },
    },
  });
  const reasons: string[] = [];
  await HerdrClient.subscribe(path, [{ type: "pane.updated" }], () => {}, (reason) => reasons.push(reason));
  await Bun.sleep(100);
  expect(reasons).toEqual(["invalid_request"]);
});

test("requests work back to back when Herdr closes the connection after each answer", async () => {
  const path = join(tmpdir(), `herdr-test-${process.pid}-${Date.now()}-oneshot.sock`);
  server = Bun.listen({
    unix: path,
    socket: {
      data(socket, chunk) {
        const req = JSON.parse(new TextDecoder().decode(chunk).trim()) as { id: string; method: string };
        socket.write(JSON.stringify({ id: req.id, result: { echo: req.method } }) + "\n");
        socket.end();
      },
    },
  });
  const client = new HerdrClient(path);
  expect(await client.request<unknown>("a")).toEqual({ echo: "a" });
  expect(await client.request<unknown>("b")).toEqual({ echo: "b" });
  expect(await Promise.all([client.request<unknown>("c"), client.request<unknown>("d")])).toEqual([{ echo: "c" }, { echo: "d" }]);
});

test("a request error carries Herdr's code", async () => {
  const path = join(tmpdir(), `herdr-test-${process.pid}-${Date.now()}-err.sock`);
  server = Bun.listen({
    unix: path,
    socket: {
      data(socket, chunk) {
        const req = JSON.parse(new TextDecoder().decode(chunk).trim()) as { id: string };
        socket.write(JSON.stringify({ id: req.id, error: { code: "not_found", message: "no pane" } }) + "\n");
        socket.end();
      },
    },
  });
  await expect(new HerdrClient(path).request("pane.get")).rejects.toMatchObject({ code: "not_found" });
});
