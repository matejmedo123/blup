// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // Build output, not source. `dist-demo` is an older export that was left
    // behind; linting it reported 8604 errors in minified bundles and buried
    // the 77 real ones underneath.
    ignores: ["dist/*", "dist-demo/*", "web-build/*"],
  }
]);
