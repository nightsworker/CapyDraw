"use strict";

const globals = require("globals");

module.exports = [
  {
    files: ["**/*.js"],
    ignores: ["node_modules/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": ["error", {argsIgnorePattern: "^_"}],
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "eqeqeq": ["error", "always"],
    },
  },
];
