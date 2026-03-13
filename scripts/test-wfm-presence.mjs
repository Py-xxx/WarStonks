#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const APP_ID = 'com.warstonks.app';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_LISTEN_MS = 2_500;
const DEFAULT_ENDPOINTS = [
  'wss://ws.warframe.market/socket',
  'wss://warframe.market/socket-v2',
];

function parseArgs(argv) {
  const args = {
    endpoint: null,
    session: null,
    token: null,
    deviceId: null,
    status: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    listenMs: DEFAULT_LISTEN_MS,
    cases: 'matrix',
    restore: false,
    raw: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--endpoint' && next) {
      args.endpoint = next;
      index += 1;
      continue;
    }
    if (arg === '--session' && next) {
      args.session = next;
      index += 1;
      continue;
    }
    if (arg === '--token' && next) {
      args.token = next;
      index += 1;
      continue;
    }
    if (arg === '--device-id' && next) {
      args.deviceId = next;
      index += 1;
      continue;
    }
    if (arg === '--status' && next) {
      args.status = next;
      index += 1;
      continue;
    }
    if (arg === '--timeout-ms' && next) {
      args.timeoutMs = Number.parseInt(next, 10) || DEFAULT_TIMEOUT_MS;
      index += 1;
      continue;
    }
    if (arg === '--listen-ms' && next) {
      args.listenMs = Number.parseInt(next, 10) || DEFAULT_LISTEN_MS;
      index += 1;
      continue;
    }
    if (arg === '--cases' && next) {
      args.cases = next;
      index += 1;
      continue;
    }
    if (arg === '--restore') {
      args.restore = true;
      continue;
    }
    if (arg === '--raw') {
      args.raw = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  pnpm test:wfm-presence [-- options]
  node ./scripts/test-wfm-presence.mjs [options]

What it does:
  - loads your saved WFM trade session by default
  - tries several websocket auth/status variants
  - prints raw route responses so we can see which protocol actually works

Options:
  --session <path>       Path to wfm-session.json
  --token <jwt>          Override token from session
  --device-id <id>       Override device id from session
  --endpoint <url>       Force one websocket endpoint instead of the test matrix
  --status <value>       Attempt a real status set (examples: online, invisible, in_game, ingame)
  --cases <name>         "matrix" (default), "read-only", or "single"
  --timeout-ms <ms>      Timeout per websocket attempt (default: ${DEFAULT_TIMEOUT_MS})
  --listen-ms <ms>       Extra listen time after sending status set (default: ${DEFAULT_LISTEN_MS})
  --restore              If --status is used, try to restore the original status afterward
  --raw                  Print full raw websocket frames

Examples:
  pnpm test:wfm-presence
  pnpm test:wfm-presence -- --status online --restore
  pnpm test:wfm-presence -- --endpoint wss://ws.warframe.market/socket --status invisible
`);
}

function getDefaultSessionPath() {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_ID, 'wfm-session.json');
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), APP_ID, 'wfm-session.json');
    default: {
      const dataHome = process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
      return path.join(dataHome, APP_ID, 'wfm-session.json');
    }
  }
}

async function loadSession(args) {
  const sessionPath = args.session ?? getDefaultSessionPath();
  const raw = await fs.readFile(sessionPath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    sessionPath,
    token: args.token ?? parsed.token,
    deviceId: args.deviceId ?? parsed.device_id ?? parsed.deviceId,
  };
}

function normalizeStatus(status) {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'in_game':
    case 'ingame':
      return 'in_game';
    case 'online':
      return 'online';
    case 'offline':
    case 'invisible':
      return 'invisible';
    default:
      return status;
  }
}

function normalizeIncomingStatus(status) {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'in_game':
    case 'ingame':
      return 'ingame';
    case 'online':
      return 'online';
    case 'offline':
    case 'invisible':
      return 'invisible';
    default:
      return status;
  }
}

function routeShort(route) {
  return route.split('|').at(1) ?? route;
}

function buildCases(args) {
  const endpoints = args.endpoint ? [args.endpoint] : DEFAULT_ENDPOINTS;

  if (args.cases === 'read-only') {
    return endpoints.map((endpoint) => ({
      name: `${endpoint} :: read current status`,
      endpoint,
      authRoute: '@wfm|cmd/auth/signIn',
      authPayloadBuilder: (token, deviceId) => ({ token, deviceId }),
      sendStatus: null,
    }));
  }

  if (args.cases === 'single') {
    return [{
      name: `${endpoints[0]} :: single`,
      endpoint: endpoints[0],
      authRoute: '@wfm|cmd/auth/signIn',
      authPayloadBuilder: (token, deviceId) => ({ token, deviceId }),
      sendStatus: args.status ? normalizeStatus(args.status) : null,
    }];
  }

  const statusValue = args.status ? normalizeStatus(args.status) : null;
  return [
    {
      name: `${endpoints[0]} :: auth deviceId + route @wfm|cmd/status/set + status ${statusValue ?? '(none)'}`,
      endpoint: endpoints[0],
      authRoute: '@wfm|cmd/auth/signIn',
      authPayloadBuilder: (token, deviceId) => ({ token, deviceId }),
      statusRoute: '@wfm|cmd/status/set',
      sendStatus: statusValue,
    },
    {
      name: `${endpoints[0]} :: auth device_id + route @wfm|cmd/status/set + status ${statusValue ?? '(none)'}`,
      endpoint: endpoints[0],
      authRoute: '@wfm|cmd/auth/signIn',
      authPayloadBuilder: (token, deviceId) => ({ token, device_id: deviceId }),
      statusRoute: '@wfm|cmd/status/set',
      sendStatus: statusValue,
    },
    {
      name: `${endpoints.at(-1)} :: auth deviceId + route @wfm|cmd/status/set + status ${statusValue ?? '(none)'}`,
      endpoint: endpoints.at(-1),
      authRoute: '@wfm|cmd/auth/signIn',
      authPayloadBuilder: (token, deviceId) => ({ token, deviceId }),
      statusRoute: '@wfm|cmd/status/set',
      sendStatus: statusValue,
    },
    {
      name: `${endpoints.at(-1)} :: auth device_id + route @wfm|cmd/status/set + status ${statusValue ?? '(none)'}`,
      endpoint: endpoints.at(-1),
      authRoute: '@wfm|cmd/auth/signIn',
      authPayloadBuilder: (token, deviceId) => ({ token, device_id: deviceId }),
      statusRoute: '@wfm|cmd/status/set',
      sendStatus: statusValue,
    },
    {
      name: `${endpoints[0]} :: auth deviceId + route cmd/status/set + status ${statusValue ?? '(none)'}`,
      endpoint: endpoints[0],
      authRoute: '@wfm|cmd/auth/signIn',
      authPayloadBuilder: (token, deviceId) => ({ token, deviceId }),
      statusRoute: 'cmd/status/set',
      sendStatus: statusValue,
    },
    {
      name: `${endpoints[0]} :: auth deviceId + route @wfm|cmd/status/set + status ingame`,
      endpoint: endpoints[0],
      authRoute: '@wfm|cmd/auth/signIn',
      authPayloadBuilder: (token, deviceId) => ({ token, deviceId }),
      statusRoute: '@wfm|cmd/status/set',
      sendStatus: args.status ? 'ingame' : null,
    },
  ];
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function runCase(testCase, session, args) {
  if (typeof WebSocket !== 'function') {
    throw new Error('Global WebSocket is not available in this Node runtime. Use Node 22+ or run the script with a runtime that supports WebSocket.');
  }

  const frames = [];
  let authenticated = false;
  let currentStatus = null;
  let setStatusResult = null;
  let errorRoute = null;

  const ws = new WebSocket(testCase.endpoint, 'wfm');

  const closePromise = new Promise((resolve) => {
    ws.addEventListener('close', (event) => resolve({ type: 'close', code: event.code, reason: event.reason }));
    ws.addEventListener('error', (event) => resolve({ type: 'error', event }));
  });

  const waitForOutcome = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${args.timeoutMs}ms`)), args.timeoutMs);

    ws.addEventListener('open', () => {
      const authMessage = {
        route: testCase.authRoute,
        payload: testCase.authPayloadBuilder(session.token, session.deviceId),
        id: crypto.randomUUID(),
      };
      ws.send(JSON.stringify(authMessage));
    });

    ws.addEventListener('message', async (event) => {
      const raw = typeof event.data === 'string' ? event.data : event.data.toString();
      const parsed = safeJsonParse(raw);
      const route = parsed?.route ? routeShort(parsed.route) : 'unknown';

      frames.push({
        route,
        raw,
        payload: parsed?.payload ?? null,
      });

      if (args.raw) {
        console.log(`  frame: ${route}`);
        console.log(`    ${raw}`);
      }

      if (!authenticated) {
        if (route === 'cmd/auth/signIn:ok') {
          authenticated = true;

          if (testCase.sendStatus) {
            const message = {
              route: testCase.statusRoute ?? '@wfm|cmd/status/set',
              payload: { status: testCase.sendStatus },
              id: crypto.randomUUID(),
            };
            ws.send(JSON.stringify(message));
            return;
          }
          return;
        }

        if (route === 'cmd/auth/signIn:error') {
          clearTimeout(timer);
          reject(new Error(parsed?.payload?.reason ?? 'Authentication failed'));
        }
        return;
      }

      if (route === 'event/status/set') {
        const receivedStatus = normalizeIncomingStatus(parsed?.payload?.status ?? null);
        if (receivedStatus) {
          currentStatus = receivedStatus;
          if (!testCase.sendStatus) {
            clearTimeout(timer);
            resolve({
              ok: true,
              mode: 'read',
              currentStatus,
              setStatusResult,
              errorRoute,
              frames,
            });
            ws.close();
            return;
          }

          if (normalizeIncomingStatus(testCase.sendStatus) === receivedStatus) {
            setStatusResult = receivedStatus;
          }
        }
      }

      if (route === 'cmd/status/set:ok') {
        setStatusResult = normalizeIncomingStatus(parsed?.payload?.status ?? testCase.sendStatus);
      }

      if (route === 'cmd/status/set:error') {
        errorRoute = raw;
        clearTimeout(timer);
        reject(new Error(parsed?.payload?.reason ?? 'Status set failed'));
        ws.close();
        return;
      }

      if (testCase.sendStatus && (setStatusResult || currentStatus)) {
        await delay(args.listenMs);
        clearTimeout(timer);
        resolve({
          ok: true,
          mode: 'write',
          currentStatus,
          setStatusResult,
          errorRoute,
          frames,
        });
        ws.close();
      }
    });
  });

  try {
    const result = await Promise.race([waitForOutcome, closePromise]);
    return { success: true, result };
  } catch (error) {
    try {
      ws.close();
    } catch {
      // ignore close errors in probe script
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      frames,
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const session = await loadSession(args);

  if (!session.token || !session.deviceId) {
    throw new Error('Missing token or device id. Provide --token and --device-id or ensure the saved session file is valid.');
  }

  console.log(`Using session: ${session.sessionPath ?? '(override only)'}`);
  console.log(`Device id: ${session.deviceId}`);
  console.log(`Mode: ${args.cases}${args.status ? ` with status=${normalizeStatus(args.status)}` : ' (read-only if no --status)'}`);

  const cases = buildCases(args).filter((testCase) => testCase.endpoint);
  let originalStatus = null;

  if (args.restore) {
    const restoreProbe = await runCase(
      {
        name: 'baseline presence read',
        endpoint: args.endpoint ?? DEFAULT_ENDPOINTS[0],
        authRoute: '@wfm|cmd/auth/signIn',
        authPayloadBuilder: (token, deviceId) => ({ token, deviceId }),
        sendStatus: null,
      },
      session,
      args,
    );
    if (restoreProbe.success) {
      originalStatus = restoreProbe.result.currentStatus ?? null;
      console.log(`Original status detected: ${originalStatus ?? 'unknown'}`);
    }
  }

  for (const testCase of cases) {
    console.log(`\n=== ${testCase.name} ===`);
    const attempt = await runCase(testCase, session, args);

    if (attempt.success) {
      const frameRoutes = attempt.result.frames.map((frame) => frame.route).join(', ');
      console.log(`success: yes`);
      console.log(`routes: ${frameRoutes || '(none)'}`);
      console.log(`current status: ${attempt.result.currentStatus ?? '—'}`);
      console.log(`set result: ${attempt.result.setStatusResult ?? '—'}`);
    } else {
      console.log(`success: no`);
      console.log(`error: ${attempt.error}`);
      if (attempt.frames.length > 0) {
        console.log(`routes: ${attempt.frames.map((frame) => frame.route).join(', ')}`);
      }
    }
  }

  if (args.restore && originalStatus && args.status) {
    console.log(`\n=== restore original status (${originalStatus}) ===`);
    const restoreAttempt = await runCase(
      {
        name: 'restore',
        endpoint: args.endpoint ?? DEFAULT_ENDPOINTS[0],
        authRoute: '@wfm|cmd/auth/signIn',
        authPayloadBuilder: (token, deviceId) => ({ token, deviceId }),
        statusRoute: '@wfm|cmd/status/set',
        sendStatus: normalizeStatus(originalStatus),
      },
      session,
      args,
    );

    if (restoreAttempt.success) {
      console.log(`restore success: yes`);
      console.log(`restored status: ${restoreAttempt.result.setStatusResult ?? restoreAttempt.result.currentStatus ?? 'unknown'}`);
    } else {
      console.log(`restore success: no`);
      console.log(`restore error: ${restoreAttempt.error}`);
    }
  }
}

main().catch((error) => {
  console.error(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
