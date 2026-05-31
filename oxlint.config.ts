import { library } from "@stll/oxlint-config";

export default library({
  ignorePatterns: ["dist/", "wasm/dist/"],
  overrides: [
    {
      files: ["scripts/**", "eval-html.ts"],
      rules: {
        "no-console": "off",
        "typescript/strict-boolean-expressions": "off",
      },
    },
    {
      files: ["**/*.{test,spec}.{ts,tsx,js,jsx}", "__test__/**"],
      rules: {
        "no-console": "off",
        "no-non-null-assertion": "off",
        "require-await": "off",
      },
    },
  ],
});
