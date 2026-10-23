// electron-builder afterPack hook: flip the Electron fuses, then ad-hoc sign (macOS, no Developer ID) — in this order,
// because flipping a fuse rewrites the binary and breaks any signature made before it. A Developer ID build is signed
// by electron-builder after this hook, so it signs the binary with the fuses already set.
//   RunAsNode                       only in the Windows package: with no system node.exe the approval / guardrail hook
//                                   runs as AgentDesk.exe + ELECTRON_RUN_AS_NODE (perm/server.mjs winHookCmd). macOS /
//                                   Linux run helper scripts in a utility process instead (main.mjs runHelper).
//   EnableNodeOptionsEnvironmentVariable, EnableNodeCliInspectArguments   off: NODE_OPTIONS / --inspect cannot inject code
//   EnableEmbeddedAsarIntegrityValidation   on where Electron supports it (macOS, Windows): a modified app.asar does not load
//   OnlyLoadAppFromAsar             on: the app is only ever loaded from app.asar
const { FuseVersion, FuseV1Options } = require("@electron/fuses");
const adhocSign = require("./adhoc-sign.cjs").default;

function fuseConfigFor(platform) {
  return {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: platform === "win32",
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    ...(platform === "darwin" || platform === "win32" ? { [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true } : {}),
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  };
}

exports.fuseConfigFor = fuseConfigFor;
exports.default = async function afterPack(context) {
  await context.packager.addElectronFuses(context, fuseConfigFor(context.electronPlatformName));
  console.log(`  • fuses set for ${context.electronPlatformName}`);
  await adhocSign(context);
};
