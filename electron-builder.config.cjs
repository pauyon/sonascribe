/**
 * electron-builder configuration.
 *
 * A JS config rather than YAML so notarization can be gated on credentials
 * actually being present: hard-coding `true` breaks every local macOS build,
 * and hard-coding `false` would silently ship an app that Gatekeeper blocks.
 */

// notarytool reads these itself; their presence is what tells us a release
// build is intended rather than a local one.
const hasAppleCredentials = Boolean(
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
)

if (process.platform === 'darwin' && !hasAppleCredentials) {
  console.warn(
    '\n  ⚠ Building macOS without notarization credentials.\n' +
      '    The result will run locally but Gatekeeper will block it elsewhere —\n' +
      '    and because this app requests microphone and audio-capture permission,\n' +
      '    it fails silently at the permission layer rather than with an error.\n' +
      '    Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID to notarize.\n'
  )
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.sonascribe.app',
  productName: 'SonaScribe',
  copyright: 'Copyright © 2026',

  directories: {
    buildResources: 'build',
    output: 'dist'
  },

  // Nothing else from the repo belongs in the bundle: source, fixtures and the
  // sidecar staging directory are all excluded by omission.
  files: ['out/**', 'package.json'],

  // Sidecars and models live outside the asar so they stay executable on disk
  // and can be code-signed individually.
  extraResources: [
    { from: 'resources/bin/${os}', to: 'bin', filter: ['**/*'] },
    // Diarization models are platform-independent, so they ship once.
    { from: 'resources/models', to: 'models', filter: ['**/*'] }
  ],

  /* -------------------------------------------------------------- Windows --- */

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: '${productName}-${version}-setup.${ext}'
    // Unsigned builds trigger a SmartScreen warning on first run. Set
    // CSC_LINK / CSC_KEY_PASSWORD to an Authenticode certificate to avoid it.
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    // Recordings and models live in %APPDATA%. Deleting them on uninstall would
    // discard gigabytes of the user's own data without asking.
    deleteAppDataOnUninstall: false
  },

  /* ---------------------------------------------------------------- macOS --- */

  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.productivity',
    // Hardened runtime plus notarization is mandatory, not optional: an
    // unnotarized app that requests microphone or audio-capture permission is
    // blocked outright, and it fails silently at the permission layer rather
    // than with a useful error.
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: hasAppleCredentials,
    extendInfo: {
      NSMicrophoneUsageDescription:
        'SonaScribe records your microphone so it can transcribe what you say. Audio is processed entirely on this device.',
      // Required by Chromium's CoreAudio Tap path (Electron 39+). Without this
      // key desktopCapturer audio fails, and there is no fallback.
      NSAudioCaptureUsageDescription:
        'SonaScribe records system audio so it can transcribe meetings and calls. Audio is processed entirely on this device.',
      // Shown when macOS asks for Screen & System Audio Recording permission.
      NSScreenCaptureUsageDescription:
        'SonaScribe needs this permission to capture system audio. No video is recorded or stored.'
    }
  },

  dmg: {
    artifactName: '${productName}-${version}-${arch}.${ext}',
    contents: [
      { x: 140, y: 200, type: 'file' },
      { x: 400, y: 200, type: 'link', path: '/Applications' }
    ]
  },

  /* ---------------------------------------------------------------- Linux --- */

  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'AudioVideo',
    artifactName: '${productName}-${version}-${arch}.${ext}'
  }
}
