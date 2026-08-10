// Mirrors the Obsidian community-directory automated review as closely as we
// can locally: obsidianmd recommended + type-checked typescript-eslint.
// Run with: npm run lint
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default tseslint.config(
  { ignores: ['main.js', 'esbuild.config.mjs', 'node_modules/**'] },
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
