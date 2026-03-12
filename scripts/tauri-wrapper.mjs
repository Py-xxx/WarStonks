import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const tauriConfigPath = path.join(projectRoot, 'src-tauri', 'tauri.conf.json');
const generatedConfigPath = path.join(projectRoot, 'src-tauri', 'tauri.dev.generated.json');
const DEFAULT_ALLOWED_PORTS = [1420, 1422, 1424, 1426];
const PNPM_COMMAND = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function parseAllowedPorts(rawValue) {
  if (!rawValue) {
    return DEFAULT_ALLOWED_PORTS;
  }

  const parsedPorts = rawValue
    .split(',')
    .map((segment) => Number.parseInt(segment.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);

  return parsedPorts.length > 0 ? parsedPorts : DEFAULT_ALLOWED_PORTS;
}

function isPortAvailable(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, host);
  });
}

async function selectAvailablePort(ports, host) {
  for (const port of ports) {
    const devPortAvailable = await isPortAvailable(port, host);
    const hmrPortAvailable = await isPortAvailable(port + 1, host);

    if (devPortAvailable && hmrPortAvailable) {
      return port;
    }
  }

  throw new Error(
    `No available dev ports found. Tried: ${ports.join(', ')} on ${host}.`,
  );
}

function runCommand(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...extraEnv,
      },
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }

      resolve(code ?? 0);
    });
  });
}

async function createGeneratedDevConfig(devPort) {
  const configJson = await fs.readFile(tauriConfigPath, 'utf8');
  const config = JSON.parse(configJson);

  config.build = {
    ...config.build,
    devUrl: `http://127.0.0.1:${devPort}`,
    beforeDevCommand: 'pnpm run dev',
  };

  await fs.writeFile(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function runTauriDev(args) {
  const host = process.env.TAURI_DEV_HOST || '127.0.0.1';
  const allowedPorts = parseAllowedPorts(process.env.TAURI_DEV_ALLOWED_PORTS);
  const selectedPort = await selectAvailablePort(allowedPorts, host);
  const hmrPort = selectedPort + 1;

  await createGeneratedDevConfig(selectedPort);

  if (process.env.TAURI_DEV_WRAPPER_DRY_RUN === '1') {
    console.log(
      JSON.stringify(
        {
          devPort: selectedPort,
          hmrPort,
          configPath: generatedConfigPath,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  return runCommand(
    PNPM_COMMAND,
    ['exec', 'tauri', 'dev', '--config', generatedConfigPath, ...args],
    {
      TAURI_DEV_HOST: host,
      TAURI_DEV_PORT: String(selectedPort),
      TAURI_DEV_HMR_PORT: String(hmrPort),
    },
  );
}

async function main() {
  const args = process.argv.slice(2);
  const [subcommand, ...restArgs] = args;

  try {
    const exitCode =
      subcommand === 'dev'
        ? await runTauriDev(restArgs)
        : await runCommand(PNPM_COMMAND, ['exec', 'tauri', ...args]);
    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tauri-wrapper] ${message}`);
    process.exit(1);
  }
}

await main();
