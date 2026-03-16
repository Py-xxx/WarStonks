import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(projectRoot, 'package.json');
const cargoTomlPath = path.join(projectRoot, 'src-tauri', 'Cargo.toml');
const tauriConfigPath = path.join(projectRoot, 'src-tauri', 'tauri.conf.json');

function updateCargoVersion(cargoToml, version) {
  const lineEnding = cargoToml.includes('\r\n') ? '\r\n' : '\n';
  const lines = cargoToml.split(/\r?\n/);
  let insidePackageSection = false;
  let updated = false;

  const nextLines = lines.map((line) => {
    const trimmed = line.trim();

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      insidePackageSection = trimmed === '[package]';
      return line;
    }

    if (insidePackageSection && trimmed.startsWith('version = ')) {
      updated = true;
      const indentation = line.match(/^\s*/)?.[0] ?? '';
      return `${indentation}version = "${version}"`;
    }

    return line;
  });

  if (!updated) {
    throw new Error('Failed to locate the [package] version in src-tauri/Cargo.toml');
  }

  return nextLines.join(lineEnding);
}

function updateTauriConfigVersion(configText, version) {
  const config = JSON.parse(configText);
  config.version = version;
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function syncVersionFiles() {
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  const version = packageJson.version?.trim();
  if (!version) {
    throw new Error('package.json does not contain a valid version');
  }

  const [cargoToml, tauriConfigText] = await Promise.all([
    fs.readFile(cargoTomlPath, 'utf8'),
    fs.readFile(tauriConfigPath, 'utf8'),
  ]);

  const nextCargoToml = updateCargoVersion(cargoToml, version);
  const nextTauriConfigText = updateTauriConfigVersion(tauriConfigText, version);

  await Promise.all([
    fs.writeFile(cargoTomlPath, nextCargoToml, 'utf8'),
    fs.writeFile(tauriConfigPath, nextTauriConfigText, 'utf8'),
  ]);

  return version;
}

async function main() {
  const version = await syncVersionFiles();
  console.log(`Synchronized app version to ${version}`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
