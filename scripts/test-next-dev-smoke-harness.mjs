import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1)));
const sourceHarness = join(root, "scripts", "next-dev-safe.mjs");
const temporaryRoot = mkdtempSync(join(tmpdir(), "intentchord-dev-smoke-harness-"));
const delayedApiMs = 2200;
const processTimeoutMs = 30 * 1000;

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(error => {
        if (error) reject(error);
        else resolvePort(port);
      });
    });
  });
}

function stopProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  child.kill("SIGKILL");
}

const fakeNext = `import http from "node:http";
import process from "node:process";

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const hostname = argumentValue("--hostname", "127.0.0.1");
const port = Number.parseInt(argumentValue("--port", "3000"), 10);
const server = http.createServer((request, response) => {
  const delay = request.url === "/api/tasks" ? ${delayedApiMs} : 75;
  setTimeout(() => {
    response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    response.end(request.url === "/api/tasks" ? "[]" : "{\\"ready\\":true}");
  }, delay);
});

function stop() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.listen(port, hostname);
`;

try {
  const harnessTarget = join(temporaryRoot, "scripts", "next-dev-safe.mjs");
  const fakeNextTarget = join(temporaryRoot, "node_modules", "next", "dist", "bin", "next");
  mkdirSync(dirname(harnessTarget), { recursive: true });
  mkdirSync(dirname(fakeNextTarget), { recursive: true });
  writeFileSync(harnessTarget, await import("node:fs/promises").then(fs => fs.readFile(sourceHarness)));
  writeFileSync(fakeNextTarget, fakeNext, "utf8");
  const port = await reservePort();

  const child = spawn(
    process.execPath,
    [harnessTarget, "--intentchord-smoke", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: temporaryRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });

  const result = await new Promise(resolveResult => {
    const timer = setTimeout(() => {
      stopProcessTree(child);
      resolveResult({ code: 124, timedOut: true });
    }, processTimeoutMs);
    child.once("exit", code => {
      clearTimeout(timer);
      resolveResult({ code: code ?? 1, timedOut: false });
    });
    child.once("error", error => {
      clearTimeout(timer);
      resolveResult({ code: 1, timedOut: false, error });
    });
  });

  const expectedMarkers = [
    "HTTP_ROOT: PASS",
    "HTTP_TASKS: PASS",
    "INTENTCHORD_DEV_SMOKE: PASS",
  ];
  const missingMarkers = expectedMarkers.filter(marker => !stdout.includes(marker));
  if (result.timedOut || result.code !== 0 || missingMarkers.length > 0) {
    console.error("DEV_SMOKE_HARNESS_REGRESSION: BLOCKER");
    console.error(`EXIT_CODE=${result.code}`);
    console.error(`TIMED_OUT=${result.timedOut}`);
    console.error(`MISSING_MARKERS=${missingMarkers.join(",") || "NONE"}`);
    if (result.error) console.error(result.error);
    if (stdout.trim()) console.error(`STDOUT=${stdout.trim()}`);
    if (stderr.trim()) console.error(`STDERR=${stderr.trim()}`);
    process.exitCode = 1;
  } else {
    console.log(
      `DEV_SMOKE_HARNESS_REGRESSION: PASS | delayed_api_ms=${delayedApiMs} | required_probe_timeout_ms=10000`,
    );
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
