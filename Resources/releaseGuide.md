# WarStonks Windows Release Guide

This guide is for the current Windows auto-update flow that is now built into the app.

The app checks this endpoint on launch:

- `https://github.com/Py-xxx/WarStonks/releases/latest/download/latest.json`

If `latest.json` points to a newer signed Windows installer, WarStonks will show an update alert in the notification panel. Pressing `Update Now` downloads the installer, runs it in passive mode, and restarts the app when the installer finishes.

## Important Rules

1. Do not release from a GitHub ZIP download.
2. Release from a real Git checkout on your Windows machine.
3. Do not change the updater signing key unless you intentionally want to break updates for existing installs.
4. Use `package.json` as the only manual version source.
5. Upload all three updater files to the GitHub Release:
   - the NSIS setup `.exe`
   - the matching `.sig`
   - `latest.json`

## One-Time Updater Key Setup

The updater is configured to trust this public key in the repo:

- `/Users/nathan/Documents/VSCodeProjects/Warstonks/WarStonks/src-tauri/tauri.conf.json`

The matching private key was generated locally on this machine and is not in the repo:

- private key: `~/.tauri/warstonks-updater.key`
- password file: `~/.tauri/warstonks-updater-password.txt`
- public key: `~/.tauri/warstonks-updater.key.pub`

To release from your Windows PC, you must securely copy the same private key and password there once.

Recommended Windows location:

- `%USERPROFILE%\\.tauri\\warstonks-updater.key`
- `%USERPROFILE%\\.tauri\\warstonks-updater-password.txt`

Do not commit these files.

## Version Source Of Truth

You now only manually change one file:

1. `/Users/nathan/Documents/VSCodeProjects/Warstonks/WarStonks/package.json`

The repo includes a sync script here:

- `/Users/nathan/Documents/VSCodeProjects/Warstonks/WarStonks/scripts/sync-version.mjs`

And a package script here:

- `pnpm version:sync`

What the sync script updates automatically from `package.json`:

1. `/Users/nathan/Documents/VSCodeProjects/Warstonks/WarStonks/src-tauri/Cargo.toml`
2. `/Users/nathan/Documents/VSCodeProjects/Warstonks/WarStonks/src-tauri/tauri.conf.json`

What is already automatic and no longer needs manual version edits:

1. the sidebar version label now reads the runtime Tauri app version
2. the Rust WFM/Alecaframe user-agent strings now derive from `CARGO_PKG_VERSION`

Important:

- `pnpm tauri dev`
- `pnpm tauri build`
- any other `pnpm tauri ...` command run through `/Users/nathan/Documents/VSCodeProjects/Warstonks/WarStonks/scripts/tauri-wrapper.mjs`

That wrapper now runs the version sync automatically before calling Tauri.

## Recommended Release Workflow

### 1. Prepare the release commit

On your main dev machine:

1. Make all code changes.
2. Update the version only in `/Users/nathan/Documents/VSCodeProjects/Warstonks/WarStonks/package.json`.
3. Run `pnpm version:sync` if you want to verify the synced files before building.
4. Commit the release-ready state.
5. Push that commit to GitHub.

Example:

```bash
git add .
git commit -m "Release 3.0.1"
git push origin main
```

### 2. Use a real Git checkout on Windows

On the Windows release PC, do not use `Download ZIP`.

Use Git instead:

```powershell
git clone https://github.com/Py-xxx/WarStonks.git
cd WarStonks
git checkout main
git pull origin main
```

Why:

- you need Git history for tags
- a ZIP download cannot be tagged and is easy to release from the wrong commit

### 3. Create the Git tag

Create the release tag on the exact commit you are shipping.

Example for version `3.0.1`:

```powershell
git tag -a v3.0.1 -m "WarStonks 3.0.1"
git push origin v3.0.1
```

Use the same version number everywhere:

- `package.json`: `3.0.1`
- tag: `v3.0.1`

## Windows Build Prerequisites

Your Windows machine needs:

1. Node + pnpm
2. Rust toolchain
3. Visual Studio C++ build tools / Windows SDK required by Tauri
4. WebView2 runtime
5. the updater private key + password files copied locally

## Build The Release On Windows

From the repo root on Windows:

```powershell
pnpm install
```

Set the updater signing environment variables for this shell:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$HOME\\.tauri\\warstonks-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content "$HOME\\.tauri\\warstonks-updater-password.txt" -Raw).Trim()
```

Then build:

```powershell
pnpm tauri build
```

This is still the correct build command.

`pnpm tauri build` now auto-runs the version sync first, so `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` will be updated from `package.json` before the Tauri build starts.

## Files Produced By The Build

After a successful Windows build, the updater release files you care about are in:

- `src-tauri\\target\\release\\bundle\\nsis\\`

You should see:

1. `WarStonks_<version>_x64-setup.exe`
2. `WarStonks_<version>_x64-setup.exe.sig`

If you want to confirm the actual generated installer filename:

```powershell
Get-ChildItem .\\src-tauri\\target\\release\\bundle\\nsis
```

## Create `latest.json`

WarStonks includes a helper script for the updater manifest:

- `/Users/nathan/Documents/VSCodeProjects/Warstonks/WarStonks/scripts/create-windows-updater-manifest.mjs`

You can run it through:

- `pnpm release:manifest`

First, create a release notes file in the repo root if you want notes shown in the updater prompt.

Example:

- `release-notes-3.0.1.md`

Then run:

```powershell
pnpm release:manifest --version 3.0.1 `
  --installer .\\src-tauri\\target\\release\\bundle\\nsis\\WarStonks_3.0.1_x64-setup.exe `
  --signature .\\src-tauri\\target\\release\\bundle\\nsis\\WarStonks_3.0.1_x64-setup.exe.sig `
  --output .\\src-tauri\\target\\release\\bundle\\nsis\\latest.json `
  --notes-file .\\release-notes-3.0.1.md `
  --tag v3.0.1
```

What this script writes:

- `version`
- `notes`
- `pub_date`
- `url`
- `signature`

The generated `url` will point to:

- `https://github.com/Py-xxx/WarStonks/releases/download/v3.0.1/<installer-name>`

## Upload The GitHub Release

Create a new GitHub Release for the tag you pushed:

- tag: `v3.0.1`

Upload these three files from `src-tauri\\target\\release\\bundle\\nsis\\`:

1. `WarStonks_3.0.1_x64-setup.exe`
2. `WarStonks_3.0.1_x64-setup.exe.sig`
3. `latest.json`

Important:

- `latest.json` must be attached to the newest published release
- the installer filename in `latest.json` must exactly match the uploaded setup `.exe`
- the signature in `latest.json` must be the exact contents of the uploaded `.sig`

Once the release is published, this URL should work:

- `https://github.com/Py-xxx/WarStonks/releases/latest/download/latest.json`

## Smoke Test The Update

After publishing:

1. install or open an older WarStonks build on Windows
2. launch the app
3. wait for startup to finish
4. open the notification panel
5. confirm you see the update alert
6. press `Update Now`
7. confirm the installer runs and the app relaunches after install

## If Something Goes Wrong

### The app does not detect the update

Check:

1. the installed app version is lower than the new release version
2. `latest.json` is attached to the newest published GitHub Release
3. the `url` inside `latest.json` points to the exact uploaded installer filename
4. the GitHub Release is not still a draft

### The build fails with signing errors

Check:

1. `TAURI_SIGNING_PRIVATE_KEY_PATH` points to the correct key file
2. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` matches the key password
3. you are using the same private key that matches the public key committed in `src-tauri/tauri.conf.json`

### The app downloads but refuses to install

Check:

1. the `.sig` file matches the uploaded installer
2. `latest.json` contains the exact signature text from the `.sig`
3. you did not regenerate the updater key without updating the app’s committed public key

## Do Not Rotate The Updater Key Casually

Existing installs trust the public key currently embedded in:

- `/Users/nathan/Documents/VSCodeProjects/Warstonks/WarStonks/src-tauri/tauri.conf.json`

If you generate a new updater keypair, already-installed apps will not trust updates signed by the new key until you ship a build that contains the new public key.

In practice:

- keep using the same updater key
- back up the private key securely
- back up the password securely

## Quick Release Checklist

1. Update all version references.
2. Commit and push the release commit.
3. On Windows, use a real Git checkout, not a ZIP.
4. Create and push tag `vX.Y.Z`.
5. Set `TAURI_SIGNING_PRIVATE_KEY_PATH`.
6. Set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
7. Run `pnpm install`.
8. Run `pnpm tauri build`.
9. Run `pnpm release:manifest ...`.
10. Upload setup `.exe`, `.sig`, and `latest.json` to the GitHub Release.
11. Publish the release.
12. Smoke test the updater from an older installed build.
