// Minimal flat ESLint config — recommended-only ruleset so the initial
// pass is signal-only. Layer in strict TS rules (no-floating-promises,
// consistent-type-imports, etc.) in a follow-up sprint once the noise
// from `recommended` is triaged.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "dist/**",
      "src-tauri/target/**",
      "node_modules/**",
      "coverage/**",
      "*.config.*",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Practical relaxations for a shipping app — revisit in Sprint C.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Codebase-wide idiom `cond && sideEffect()` for React JSX branches
      // and event handlers — legitimate short-circuit calls, not dead code.
      "@typescript-eslint/no-unused-expressions": [
        "warn",
        { allowShortCircuit: true, allowTernary: true },
      ],
      // Extra escapes inside regex/strings are harmless and often kept
      // for clarity when the same pattern is copy-pasted between engines.
      "no-useless-escape": "warn",
    },
  },
];
