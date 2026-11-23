# Canon docs (oncanon.com)

Astro site for the Canon docs and public pages. Local-only for now — see
`AGENTS.md` at the repo root for the Phase 1 boundary.

## Node version

Astro requires **Node >= 22.23.4**. `engines.node` in `package.json` plus
`engine-strict=true` in `.npmrc` make `npm install` / `npm run build` fail
fast with that requirement spelled out if you're on an older Node — rather
than failing mid-build with Astro's own less obvious error. `.nvmrc` /
`.node-version` pin the same version for `nvm use` / `fnm use` / asdf.

## 🚀 Project Structure

Inside of your Astro project, you'll see the following folders and files:

```text
/
├── public/
├── src/
│   └── pages/
│       └── index.astro
└── package.json
```

Astro looks for `.astro` or `.md` files in the `src/pages/` directory. Each page is exposed as a route based on its file name.

There's nothing special about `src/components/`, but that's where we like to put any Astro/React/Vue/Svelte/Preact components.

Any static assets, like images, can be placed in the `public/` directory.

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |

## 👀 Want to learn more?

Feel free to check [our documentation](https://docs.astro.build) or jump into our [Discord server](https://astro.build/chat).
