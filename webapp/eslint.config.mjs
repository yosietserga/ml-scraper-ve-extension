import next from "eslint-config-next";

// eslint-config-next v16 ships a flat config array as its default export.
const baseConfig = (next).filter(Boolean);

const eslintConfig = [
  ...baseConfig,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "dist/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
