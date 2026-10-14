// login.ts
import { createInterface } from "node:readline";
import { launchPersistentContext } from "cloakbrowser";

const account = process.argv[2];
if (!account) throw new Error("Usage: bun login.js <account-name>");

const context = await launchPersistentContext({
  userDataDir: `./auth/${account}`,
  headless: false,
});

let closing = false;

async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await context.close();
  } catch {
    // Already closed, for example if you shut the browser window yourself.
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(
  "https://accounts.google.com/signin/v2/identifier?continue=https%3A%2F%2Fmyaccount.google.com%2F",
);

const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log(
  `Sign in to "${account}", then press Enter here (or Ctrl+C) to save and close.`,
);

rl.once("line", () => {
  rl.close();
  shutdown();
});
