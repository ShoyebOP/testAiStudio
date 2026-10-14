// Main workflow: one <account> selects BOTH the browser profile and the rclone remote.
//   Browser: ./auth/<account>/            (cloakbrowser persistent context)
//   Rclone:  <account>: in ./auth/<account>/rclone.conf (portable, gitignored)
//   Work:    ./tmp/<account>/             (staging, gitignored; cleaned every run)
//   Notes:   ./notes/<input-name>.md      (global folder, kept across runs)
//   System instructions: ./system_instructions.md (global file, read every run)
// Usage: bun main.js <account> <local-file> [remote-path] [--headless]
//   Headed (visible browser) is the default; pass --headless to hide it.
import { existsSync, copyFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, basename, extname, resolve } from "node:path";
import { launchPersistentContext } from "cloakbrowser";
import {
  resolveAccount,
  assertBrowserProfile,
  assertRcloneRemote,
  ensureCleanWorkDir,
  rcloneArgs,
  getRemoteSize,
  killStaleBrowser,
} from "./lib/account.js";
import {
  NEW_CHAT_URL,
  gotoNewChat,
  setSystemInstructions,
  runPrompt,
  attachDriveLink,
  waitForAttachmentReady,
  waitForDone,
  copyLatestResponseMarkdown,
} from "./lib/aistudio.js";

const rawArgs = process.argv.slice(2);
let headless = false;
let genTimeoutMs = 30 * 60 * 1000; // long generations (e.g. 1h audio) take 5-10+ min
const positionals = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--headless") headless = true;
  else if (a === "--gen-timeout") {
    const mins = Number(rawArgs[++i]);
    if (!Number.isFinite(mins) || mins <= 0) {
      throw new Error("Usage: --gen-timeout <minutes> (positive number)");
    }
    genTimeoutMs = mins * 60 * 1000;
  } else if (a.startsWith("--")) {
    throw new Error(`Unknown flag: ${a}`);
  } else {
    positionals.push(a);
  }
}
const [accountArg, localFile, remotePath = "uploads/"] = positionals;
if (!accountArg || !localFile) {
  throw new Error(
    "Usage: bun main.js <account> <local-file> [remote-path] [--headless] [--gen-timeout <minutes>]",
  );
}

const { account, userDataDir, rcloneConfig, rcloneRemote, workDir } =
  resolveAccount(accountArg);

// Both sides resolve from the SAME account name.
assertBrowserProfile(userDataDir);
assertRcloneRemote(rcloneRemote, rcloneConfig);
if (!existsSync(localFile)) {
  throw new Error(`Local file not found: ${localFile}`);
}

// Global system instructions file (single source, used for every run).
const SYS_FILE = "./system_instructions.md";
if (!existsSync(SYS_FILE)) {
  await Bun.write(SYS_FILE, "You are a helpful study assistant.\n");
  throw new Error(
    `Created ${SYS_FILE} with a default. Edit it, then re-run.`,
  );
}
const sysText = (await Bun.file(SYS_FILE).text()).trim();
if (!sysText) {
  throw new Error(`${SYS_FILE} is empty. Put the system instructions in it.`);
}

// All staging work happens inside the per-account temp dir:
// create it if missing, clean it if it exists.
const dirState = ensureCleanWorkDir(workDir);
console.log(
  `[${account}] Work dir ${workDir}/ (${dirState.created ? "created" : "cleaned"}).`,
);
const staged = join(workDir, basename(localFile));
copyFileSync(localFile, staged);

const fileName = basename(staged);
const dest = `${rcloneRemote}${remotePath.replace(/\/$/, "")}/${fileName}`;

// Skip upload when the exact file is already in Drive (path + byte size).
const localSize = Bun.file(localFile).size;
const remoteSize = getRemoteSize(rcloneConfig, dest);
if (remoteSize !== null && remoteSize === localSize) {
  console.log(
    `[${account}] Already in Drive: ${dest} (${localSize} bytes match). Skipping upload.`,
  );
} else {
  if (remoteSize !== null) {
    console.log(
      `[${account}] Drive copy differs (remote ${remoteSize} vs local ${localSize} bytes). Re-uploading.`,
    );
  }
  console.log(`[${account}] Uploading ${staged} -> ${dest}`);
  let upload = Bun.spawnSync(
    ["rclone", ...rcloneArgs(rcloneConfig, "copyto", staged, dest)],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (upload.exitCode !== 0) {
    throw new Error(`rclone copyto failed: ${upload.stderr.toString().trim()}`);
  }
}

let link = Bun.spawnSync(
  ["rclone", ...rcloneArgs(rcloneConfig, "link", dest)],
  { stdout: "pipe", stderr: "pipe" },
);
if (link.exitCode !== 0) {
  throw new Error(`rclone link failed: ${link.stderr.toString().trim()}`);
}
const publicUrl = link.stdout.toString().trim();
console.log(`[${account}] Public link: ${publicUrl}`);

// The prompt input is the Drive link, not a pasted file.
await Bun.write(
  join(workDir, "upload.json"),
  JSON.stringify(
    { account, localFile: staged, dest, publicUrl, at: new Date().toISOString() },
    null,
    2,
  ),
);
await Bun.write(join(workDir, "drive_link.txt"), publicUrl + "\n");

// Same account's browser state. Google-side flakes (e.g. "failed to load
// file" popups) are retried with a fresh browser, flow restarted from scratch.
const MAX_ATTEMPTS = 3;
let markdown = null;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const stale = killStaleBrowser(userDataDir);
  if (stale.length) {
    console.log(`[${account}] Killed stale browser PID(s): ${stale.join(", ")}.`);
    await Bun.sleep(2000);
  }
  let context = null;
  try {
    console.log(
      `[${account}] Browser attempt ${attempt}/${MAX_ATTEMPTS} (${headless ? "headless" : "headed"}) ...`,
    );
    try {
      context = await launchPersistentContext({ userDataDir, headless });
    } catch (e) {
      if (/already in use/i.test(e.message || "")) {
        throw new Error(
          `Browser profile ${userDataDir} is already in use by another Chromium. ` +
            `Close it and re-run.`,
        );
      }
      throw e;
    }
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const page = context.pages()[0] ?? (await context.newPage());
    await gotoNewChat(page);
    console.log(`[${account}] New chat: ${NEW_CHAT_URL}`);

    await setSystemInstructions(page, sysText);
    console.log(`[${account}] System instructions set from ${SYS_FILE}.`);

    const pasteMethod = await attachDriveLink(page, publicUrl);
    console.log(
      `[${account}] Drive link pasted (via ${pasteMethod}). Waiting for file to load...`,
    );
    const chip = await waitForAttachmentReady(page);
    console.log(`[${account}] File loaded: ${chip.text}`);

    await runPrompt(page);
    console.log(`[${account}] Prompt sent (file attached). Waiting for generation (timeout ${Math.round(genTimeoutMs / 60000)} min)...`);
    await waitForDone(page, { timeoutMs: genTimeoutMs });
    console.log(`[${account}] Generation complete. Copying markdown...`);
    markdown = await copyLatestResponseMarkdown(page);
    try {
      await context.close();
    } catch {}
    context = null;
    break;
  } catch (e) {
    try {
      if (context) await context.close();
    } catch {}
    if (e.retryable && attempt < MAX_ATTEMPTS) {
      console.log(
        `[${account}] Attempt ${attempt} hit transient error: ${e.message}. Restarting flow...`,
      );
      await Bun.sleep(5000);
      continue;
    }
    throw e;
  }
}

// Global notes folder: <input-name-without-ext>.md
mkdirSync("./notes", { recursive: true });
const noteName = basename(fileName, extname(fileName)) + ".md";
const notePath = join("./notes", noteName);
await Bun.write(notePath, markdown);
const saved = await Bun.file(notePath).text();
if (!saved.trim()) {
  throw new Error(
    `Note ${notePath} is empty — keeping input files for retry.`,
  );
}
console.log(`[${account}] Note saved: ${notePath} (${saved.length} chars).`);

// Inputs are removed only now that a non-empty note is confirmed on disk.
// Local: only the staged copy inside the work dir — never the user's original file.
if (
  resolve(staged).startsWith(resolve(workDir) + "/") &&
  existsSync(staged)
) {
  unlinkSync(staged);
  console.log(`[${account}] Removed staged input: ${staged}`);
}
// Original input file: removed per workflow policy, but never project files.
{
  const origResolved = resolve(localFile);
  const protectedDirs = [
    resolve("./auth"),
    resolve("./notes"),
    resolve("./lib"),
    resolve("./tmp"),
  ];
  const protectedFiles = new Set(
    [
      "./system_instructions.md",
      "./main.js",
      "./login.js",
      "./package.json",
    ].map((p) => resolve(p)),
  );
  const isStagedCopy = origResolved === resolve(staged);
  const protectedHit =
    protectedFiles.has(origResolved) ||
    protectedDirs.some(
      (d) => origResolved === d || origResolved.startsWith(d + "/"),
    );
  if (protectedHit && !isStagedCopy) {
    console.log(
      `[${account}] WARNING: refusing to delete protected path: ${localFile}`,
    );
  } else if (!isStagedCopy && existsSync(origResolved)) {
    unlinkSync(origResolved);
    console.log(`[${account}] Removed original input: ${localFile}`);
  }
}
const del = Bun.spawnSync(
  ["rclone", ...rcloneArgs(rcloneConfig, "delete", dest)],
  { stdout: "pipe", stderr: "pipe" },
);
if (del.exitCode !== 0) {
  console.log(
    `[${account}] WARNING: Drive cleanup failed for ${dest}: ${del.stderr.toString().trim()}`,
  );
} else {
  console.log(`[${account}] Removed Drive input: ${dest}`);
}
