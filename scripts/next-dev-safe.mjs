import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const rawArgs = process.argv.slice(2);
const smokeMode = rawArgs.includes("--intentchord-smoke");
const nextArgs = rawArgs.filter((argument) => argument !== "--intentchord-smoke");
const devDirName = smokeMode ? ".next-dev-smoke" : ".next-dev";
const devDir = join(root, devDirName);
const devLock = join(devDir, "dev", "lock");
const nextEnvPath = join(root, "next-env.d.ts");
const tsconfigPath = join(root, "tsconfig.json");
const originalNextEnv = existsSync(nextEnvPath) ? readFileSync(nextEnvPath) : null;
const originalTsconfig = existsSync(tsconfigPath) ? readFileSync(tsconfigPath) : null;
const staleAfterMs = 30 * 60 * 1000;
const smokeTimeoutMs = 90 * 1000;
const smokeProbeTimeoutMs = 10 * 1000;

let configurationRestored = false;
function restoreConfiguration() {
  if (configurationRestored) return;
  configurationRestored = true;
  try {
    if (originalNextEnv === null) {
      rmSync(nextEnvPath, { force: true });
    } else {
      writeFileSync(nextEnvPath, originalNextEnv);
    }
    if (originalTsconfig === null) {
      rmSync(tsconfigPath, { force: true });
    } else {
      writeFileSync(tsconfigPath, originalTsconfig);
    }
  } catch (error) {
    console.error("[IntentChord dev] Failed to restore Next.js-generated configuration changes.");
    console.error(error);
    process.exitCode = 1;
  }
}

function isolateStaleDevDirectory(reason) {
  if (!existsSync(devDir)) return;
  const quarantine = join(root, `${devDirName}.stale-${Date.now()}-${process.pid}`);
  try {
    renameSync(devDir, quarantine);
    console.log(`[IntentChord dev] Isolated ${devDirName} because ${reason}: ${quarantine}`);
    return;
  } catch (renameError) {
    try {
      rmSync(devDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      console.log(`[IntentChord dev] Removed ${devDirName} because ${reason}.`);
      return;
    } catch (removeError) {
      console.error(`[IntentChord dev] Unable to isolate stale ${devDirName}.`);
      console.error(renameError);
      console.error(removeError);
      restoreConfiguration();
      process.exit(1);
    }
  }
}

function argumentValue(longName, shortName, fallback) {
  for (let index = 0; index < nextArgs.length; index += 1) {
    const argument = nextArgs[index];
    if (argument === longName || argument === shortName) {
      return nextArgs[index + 1] ?? fallback;
    }
    if (argument.startsWith(`${longName}=`)) {
      return argument.slice(longName.length + 1) || fallback;
    }
  }
  return fallback;
}

if (existsSync(devLock)) {
  try {
    if (Date.now() - statSync(devLock).mtimeMs > staleAfterMs) {
      isolateStaleDevDirectory("a stale development lock was detected");
    }
  } catch {
    isolateStaleDevDirectory("the development lock was unreadable");
  }
}

const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "dev", ...nextArgs], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    INTENTCHORD_NEXT_DIST_DIR: devDirName,
  },
});

let stopping = false;
let smokePassed = false;
let smokeFailed = false;
let smokeRootPassed = false;
let probeInFlight = false;
let pollTimer;
let smokeDeadlineTimer;
let forceStopTimer;

function stopChild(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  if (!child.killed) child.kill(signal);
  forceStopTimer = setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 5000);
  forceStopTimer.unref();
}

function probe(hostname, port) {
  if (smokePassed || smokeFailed || stopping || probeInFlight) return;
  probeInFlight = true;
  const path = smokeRootPassed ? "/api/tasks" : "/";
  const request = http.get(
    {
      hostname,
      port,
      path,
      timeout: smokeProbeTimeoutMs,
      headers: { Connection: "close" },
    },
    (response) => {
      response.resume();
      response.on("end", () => {
        probeInFlight = false;
      });
      if (!smokeFailed && !stopping && response.statusCode === 200) {
        if (!smokeRootPassed) {
          smokeRootPassed = true;
          console.log(`[IntentChord dev] HTTP_ROOT: PASS (${response.statusCode}) http://${hostname}:${port}/`);
          return;
        }
        smokePassed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (smokeDeadlineTimer) clearTimeout(smokeDeadlineTimer);
        console.log(`[IntentChord dev] HTTP_TASKS: PASS (${response.statusCode}) http://${hostname}:${port}/api/tasks`);
        console.log(
          `[IntentChord dev] INTENTCHORD_DEV_SMOKE: PASS (${response.statusCode}) http://${hostname}:${port}/api/tasks`,
        );
        stopChild();
      }
    },
  );
  request.on("timeout", () => request.destroy());
  request.on("error", () => {
    probeInFlight = false;
  });
}

if (smokeMode) {
  const hostname = argumentValue("--hostname", "-H", "127.0.0.1");
  const portText = argumentValue("--port", "-p", "3000");
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[IntentChord dev] Invalid smoke-test port: ${portText}`);
    smokeFailed = true;
    stopChild();
  } else {
    pollTimer = setInterval(() => probe(hostname, port), 350);
    smokeDeadlineTimer = setTimeout(() => {
      smokeFailed = true;
      const pendingGate = smokeRootPassed ? "HTTP_TASKS" : "HTTP_ROOT";
      console.error(
        `[IntentChord dev] INTENTCHORD_DEV_SMOKE: FAIL — ${pendingGate} was not confirmed within ${smokeTimeoutMs / 1000}s.`,
      );
      stopChild();
    }, smokeTimeoutMs);
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => stopChild(signal));
}

child.on("exit", (code, signal) => {
  if (pollTimer) clearInterval(pollTimer);
  if (smokeDeadlineTimer) clearTimeout(smokeDeadlineTimer);
  if (forceStopTimer) clearTimeout(forceStopTimer);
  restoreConfiguration();

  if (smokeMode) {
    process.exit(smokePassed && !smokeFailed ? 0 : code ?? 1);
  }

  if (signal) {
    process.exit(signal === "SIGINT" ? 130 : 0);
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  if (pollTimer) clearInterval(pollTimer);
  if (smokeDeadlineTimer) clearTimeout(smokeDeadlineTimer);
  restoreConfiguration();
  console.error(error);
  process.exit(1);
});

process.on("exit", restoreConfiguration);
