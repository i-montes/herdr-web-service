/** Injectable command runner so effectful tunnel steps can be tested without real binaries. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (argv: string[], opts?: { inherit?: boolean }) => Promise<RunResult>;

export const defaultRun: Runner = async (argv, opts) => {
  try {
    if (opts?.inherit) {
      const p = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] });
      return { code: await p.exited, stdout: "", stderr: "" };
    }
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    // binary missing: spawn throws ENOENT
    return { code: 127, stdout: "", stderr: String(e) };
  }
};
