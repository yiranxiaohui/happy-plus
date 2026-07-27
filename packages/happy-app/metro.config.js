const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

// Add support for .wasm files (required by Skia for all platforms)
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/installation/
config.resolver.assetExts.push('wasm');

// Treat .html as a bundled asset so the self-contained terminal page
// (assets/terminal/index.html) can be require()'d and loaded via expo-asset.
config.resolver.assetExts.push('html');

// Exclude Tauri Rust build artifacts from Metro's file watcher.
// Cargo writes/deletes transient files in src-tauri/target/debug/deps during
// `tauri dev`, which crashes Metro's fallback watcher on Windows with ENOENT.
config.resolver.blockList = [
  /[/\\]src-tauri[/\\]target[/\\].*/,
];

// Force every preact / preact/hooks import (ESM or CJS, from any package) to
// resolve to a SINGLE file. preact's package.json exports field maps "import"
// to preact.mjs and "require" to preact.js, which makes Metro register two
// separate module instances depending on the importer's module type. Two
// instances mean two `options` objects — preact/hooks patches one,
// @pierre/trees renders against the other, currentComponent stays undefined,
// `r.__H` crashes. Pin to the CJS bundles so everyone shares state.
const preactCjsPath = require.resolve('preact');
const preactHooksCjsPath = require.resolve('preact/hooks');

// Force the libsodium family to their CJS builds. Their "import" condition
// points at ESM files whose emscripten loader uses `import.meta` (since
// libsodium 0.8.4), but Metro emits web bundles as classic (non-module)
// scripts, so a bundled `import.meta` is a hard SyntaxError that
// white-screens the whole app.
const sodiumCjsPaths = {};
for (const name of ['libsodium', 'libsodium-wrappers', 'libsodium-sumo', 'libsodium-wrappers-sumo']) {
  try {
    sodiumCjsPaths[name] = require.resolve(name);
  } catch { }
}

const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'preact') {
    return { filePath: preactCjsPath, type: 'sourceFile' };
  }
  if (moduleName === 'preact/hooks') {
    return { filePath: preactHooksCjsPath, type: 'sourceFile' };
  }
  if (sodiumCjsPaths[moduleName]) {
    return { filePath: sodiumCjsPaths[moduleName], type: 'sourceFile' };
  }
  if (baseResolveRequest) {
    return baseResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

// Enable inlineRequires for proper Skia and Reanimated loading
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/web/
// Without this, Skia throws "react-native-reanimated is not installed" error
// This is cross-platform compatible (iOS, Android, web)
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true, // Critical for @shopify/react-native-skia
  },
});

module.exports = config;