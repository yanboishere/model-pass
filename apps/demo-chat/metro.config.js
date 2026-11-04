// Expo auto-detects the npm workspace (watchFolders / nodeModulesPaths); this file only exists to
// make that explicit and to let workspace packages ship TypeScript sources.
const { getDefaultConfig } = require('expo/metro-config')

module.exports = getDefaultConfig(__dirname)
