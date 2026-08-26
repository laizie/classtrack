import type { ForgeConfig } from '@electron-forge/shared-types';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const isSigning = !!(process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_APP_PASSWORD);

/**
 * Put the Windows now-playing addon into the packaged app.
 *
 * The Vite plugin packages only `/.vite`, on the sound assumption that a bundled main
 * process needs nothing else. That holds for every dependency except a native one: a
 * .node binary cannot be bundled into a JS file, so it has to travel as a real file — and
 * it wasn't. SMTC therefore never worked in any release build. It failed silently, because
 * the loader catches the failed import and returns null, so nothing ever pointed at the
 * cause.
 *
 * Copying it in here rather than widening `packagerConfig.ignore` is deliberate. Letting
 * `/node_modules` through the ignore filter hands the decision to packager's `prune` step,
 * which then copies the ENTIRE production dependency tree — measured at 115 packages,
 * every one of them already bundled into main.js by Vite. This hook runs after packager
 * has copied the app and before the asar is sealed, so the two directories we actually
 * want are the only two that ship.
 *
 * napi-rs splits the module in two: a pure-JS wrapper, and a per-platform package holding
 * the binary. binding.js prefers a .node sitting next to itself and only falls back to
 * resolving the platform package, so the binary is copied INTO the wrapper directory and
 * the platform package never needs to ship at all. `asar.unpack: '**\/*.node'` then lifts
 * the binary back out of the archive, which is what makes it loadable — Node cannot dlopen
 * a file inside an asar, and Electron's asar layer redirects both the existsSync check and
 * the require to the unpacked copy.
 */
function bundleWindowsSmtc(buildPath: string, arch: string): void {
  const pkgRoot = path.join(__dirname, 'node_modules', '@coooookies');
  const wrapperSrc = path.join(pkgRoot, 'windows-smtc-monitor');
  const binaryName = `windows-smtc-monitor.win32-${arch}-msvc.node`;
  const binarySrc = path.join(pkgRoot, `windows-smtc-monitor-win32-${arch}-msvc`, binaryName);

  // Loudly, not quietly. Shipping a Windows build whose now-playing silently does
  // nothing is the exact failure this function exists to end, so a missing binary
  // fails the build instead of producing another one.
  if (!existsSync(wrapperSrc) || !existsSync(binarySrc)) {
    throw new Error(
      `Cannot package the Windows now-playing addon for ${arch}: ` +
        `${!existsSync(wrapperSrc) ? wrapperSrc : binarySrc} is missing. ` +
        'npm only installs that optional dependency on Windows, so a win32 package has ' +
        'to be built on Windows (which is what the build-windows CI job does).',
    );
  }

  const dest = path.join(buildPath, 'node_modules', '@coooookies', 'windows-smtc-monitor');
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(wrapperSrc, dest, { recursive: true });
  cpSync(binarySrc, path.join(dest, binaryName));
}

const config: ForgeConfig = {
  packagerConfig: {
    // unpack native addons (.node) so they can be loaded from disk at runtime —
    // Node can't dlopen a binary that's still inside the asar archive.
    // Used by the Windows now-playing module (@coooookies/windows-smtc-monitor).
    // This only does anything because `ignore` below actually lets that module into
    // the package; on its own it was unpacking a file that was never copied.
    asar: { unpack: '**/*.node' },
    name: 'Studeo',
    // Forge appends the right extension per platform: .icns on macOS, .ico on Windows
    icon: './assets/icon',
    // Copied into the packaged app's resources so the system-tray icon can be
    // loaded at runtime (process.resourcesPath) on Windows/Linux.
    extraResource: ['./assets/icon.png'],
    appBundleId: 'com.studeo.app',
    appCategoryType: 'public.app-category.education',
    ...(isSigning && {
      osxSign: {
        identity: `Developer ID Application: ${process.env.APPLE_TEAM_NAME ?? ''} (${process.env.APPLE_TEAM_ID})`,
      },
      // notarytool is the only notarization tool now, so the old `tool` field is gone
      osxNotarize: {
        appleId: process.env.APPLE_ID!,
        appleIdPassword: process.env.APPLE_APP_PASSWORD!,
        teamId: process.env.APPLE_TEAM_ID!,
      },
    }),
  },
  rebuildConfig: {},
  makers: [
    // Windows — produces a Squirrel installer (.exe)
    new MakerSquirrel({
      name: 'Studeo',
      setupIcon: './assets/icon.ico',
      setupExe: 'StudeoSetup.exe',
    }),
    // macOS — produces a drag-to-Applications DMG
    new MakerDMG({
      name: 'Studeo',
      icon: './assets/icon.icns',
    }),
    // macOS fallback ZIP (also used by GitHub Actions artifact uploads)
    new MakerZIP({}, ['darwin']),
  ],
  hooks: {
    // Runs after packager has copied the app and before the asar is sealed, which is the
    // only window in which extra files can still be added to the archive.
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
      if (platform === 'win32') bundleWindowsSmtc(buildPath, arch);
    },
  },
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
    }),
  ],
};

export default config;
