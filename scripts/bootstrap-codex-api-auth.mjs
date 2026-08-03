import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function main() {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
  const settings = await readEnvFile(join(projectRoot, ".env"));
  const apiKey = settings.OPENAI_API_KEY;
  const codexHome = settings.CODEX_HOME;

  if (!apiKey) throw new Error("OPENAI_API_KEY is missing from the project .env file.");
  if (!codexHome) throw new Error("CODEX_HOME is missing from the project .env file.");

  await mkdir(codexHome, { recursive: true });
  const provider = await resolveProvider(codexHome);
  if (provider === "openai") {
    await validateOpenAiApiKey(apiKey);
  } else {
    console.log(`Using custom Codex provider: ${provider}. Skipping api.openai.com key validation.`);
  }
  const command = resolveCodexCommand(settings);
  const childEnv = { ...process.env, CODEX_HOME: codexHome };
  if (!childEnv.HOME && childEnv.USERPROFILE) childEnv.HOME = childEnv.USERPROFILE;

  const login = await run(command, ["login", "--with-api-key"], childEnv, apiKey);
  if (login.code !== 0) throw new Error("Codex rejected the API login initialization. Check the configured key and Codex CLI installation.");

  const status = await run(command, ["login", "status"], childEnv);
  if (status.code !== 0) throw new Error("Codex API login did not persist in the configured CODEX_HOME.");

  console.log("Codex API authentication initialized for the configured CODEX_HOME.");
  console.log("Codex login status verified.");
}

function resolveCodexCommand(env) {
  if (env.CODEX_COMMAND) {
    const [executable, ...prefixArgs] = env.CODEX_COMMAND.split("|").map((part) => part.trim()).filter(Boolean);
    if (executable) return { executable, prefixArgs };
  }
  if (process.platform === "win32") {
    const entrypoint = join(process.env.APPDATA || "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(entrypoint)) return { executable: process.execPath, prefixArgs: [entrypoint] };
  }
  return { executable: "codex", prefixArgs: [] };
}

function run(command, args, env, stdin) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command.executable, [...command.prefixArgs, ...args], {
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(stdin ? `${stdin}\n` : undefined);
  });
}

async function resolveProvider(codexHome) {
  try {
    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    const match = config.match(/^\s*model_provider\s*=\s*["']([^"']+)["']\s*$/m);
    return match?.[1] || "openai";
  } catch (error) {
    if (error.code === "ENOENT") return "openai";
    throw error;
  }
}

async function validateOpenAiApiKey(key) {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` }
  });
  if (!response.ok) {
    await response.arrayBuffer();
    throw new Error(`OpenAI API key validation failed (HTTP ${response.status}). Use an active OpenAI Platform API key for api.openai.com.`);
  }
}

async function readEnvFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  const values = {};
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}
