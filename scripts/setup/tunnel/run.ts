/** Injectable command runner so effectful tunnel steps can be tested without real binaries. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * `inherit`: the command owns the terminal, nothing is captured. `tee`: output is shown as it
 * arrives and also returned (for commands that may print a link and wait on the user).
 */
export type Runner = (argv: string[], opts?: { inherit?: boolean; tee?: boolean }) => Promise<RunResult>;

async function collect(stream: ReadableStream<Uint8Array>, show?: NodeJS.WriteStream): Promise<string> {
  if (!show) return new Response(stream).text();
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    const part = decoder.decode(chunk, { stream: true });
    show.write(part);
    text += part;
  }
  return text + decoder.decode();
}

export const defaultRun: Runner = async (argv, opts) => {
  try {
    if (opts?.inherit) {
      const p = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] });
      return { code: await p.exited, stdout: "", stderr: "" };
    }
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      collect(p.stdout, opts?.tee ? process.stdout : undefined),
      collect(p.stderr, opts?.tee ? process.stderr : undefined),
      p.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    // binary missing: spawn throws ENOENT
    return { code: 127, stdout: "", stderr: String(e) };
  }
};
