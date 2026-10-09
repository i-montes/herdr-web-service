/** Step 2: the host-only password prompt. */
import { passwordConfigured, passwordRules, setPassword } from "../../server/auth/password.ts";
import { confirm, readSecret } from "../tui.ts";

/** ask, confirm, validate; repeats until a valid password is stored */
export async function askAndSetPassword(): Promise<void> {
  const tty = process.stdin.isTTY;
  if (tty) console.log(`Rules: ${passwordRules("").map((rule) => rule.label).join(" · ")}\n`);
  for (;;) {
    const password = await readSecret("Password:", { rules: tty });
    try {
      if (tty && password !== (await readSecret("Repeat the password:"))) throw new Error("the passwords do not match, start over");
      await setPassword(password);
      console.log("password saved");
      return;
    } catch (error) {
      console.log(`${(error as Error).message}\n`);
      if (!tty) process.exit(1);
    }
  }
}

/** Sets the password on a first run; afterwards only when the user asks to change it. */
export async function passwordStep(): Promise<void> {
  if (passwordConfigured() && !confirm("A password is already set. Change it?", false)) return;
  await askAndSetPassword();
}
