import config from "@iobroker/eslint-config";
import mochaPlugin from "eslint-plugin-mocha";
export default [
	...config,
	{ ignores: ["build/", "admin/", "*.config.mjs"] },
	{
		files: ["test/**/*.js"],
		plugins: { mocha: mochaPlugin },
		languageOptions: {
			globals: {
				describe: "readonly",
				it: "readonly",
				before: "readonly",
				after: "readonly",
				beforeEach: "readonly",
				afterEach: "readonly",
			},
		},
		rules: {
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
			"mocha/no-exclusive-tests": "error",
		},
	},
];
