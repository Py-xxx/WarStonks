import { basename, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

const RELEASE_BASE_URL = 'https://github.com/Py-xxx/WarStonks/releases/download';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    index += 1;
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version?.trim();
  const installer = args.installer?.trim();
  const signature = args.signature?.trim();
  const output = args.output?.trim();
  const notesFile = args['notes-file']?.trim() ?? null;
  const tag = args.tag?.trim() ?? `v${version}`;

  if (!version || !installer || !signature || !output) {
    throw new Error(
      'Usage: node scripts/create-windows-updater-manifest.mjs --version <version> --installer <path> --signature <path> --output <path> [--notes-file <path>] [--tag <git-tag>]',
    );
  }

  const installerPath = resolve(installer);
  const signaturePath = resolve(signature);
  const outputPath = resolve(output);
  const notesPath = notesFile ? resolve(notesFile) : null;

  const signatureText = (await readFile(signaturePath, 'utf8')).trim();
  if (!signatureText) {
    throw new Error(`Signature file is empty: ${signaturePath}`);
  }

  const notes = notesPath ? (await readFile(notesPath, 'utf8')).trim() : '';
  const installerName = basename(installerPath);

  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    url: `${RELEASE_BASE_URL}/${tag}/${installerName}`,
    signature: signatureText,
  };

  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Wrote updater manifest to ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
