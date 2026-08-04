import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "web/dist/", ".wrangler/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // Userscripts run in the browser under a script manager, so they see both
    // the DOM and the manager's GM_* bridge — neither of which is in scope for
    // the Worker code the base config targets.
    files: ["tap/**/*.js", "tap/**/*.ts"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        location: "readonly",
        alert: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        Blob: "readonly",
        FileReader: "readonly",
        Response: "readonly",
        TextDecoder: "readonly",
        URL: "readonly",
        unsafeWindow: "readonly",
        GM_setValue: "readonly",
        GM_getValue: "readonly",
        GM_deleteValue: "readonly",
        GM_addValueChangeListener: "readonly",
        GM_xmlhttpRequest: "readonly",
        GM_registerMenuCommand: "readonly",
      },
    },
  },
);
