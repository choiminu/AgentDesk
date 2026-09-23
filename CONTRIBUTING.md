# Contributing to AgentDesk

Thank you for your interest in contributing! Here's how you can help.

## Getting Started

```bash
git clone https://github.com/choiminu/AgentDesk.git
cd AgentDesk
npm install
npm start
```

## Development

The project has a simple structure:

- `main.mjs` — Electron main process and IPC handlers
- `widget.html` — Single-file frontend (HTML + CSS + JS)
- `preload.cjs` — Context bridge between main and renderer
- `package.json` — App config and electron-builder settings

Run in development mode:

```bash
npm run dev
```

Build DMG:

```bash
npm run dist
```

## How to Contribute

### Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- macOS version and Orca version (`orca --version`)

### Suggesting Features

Open an issue describing:
- What problem it solves
- How it should work
- Mockup or screenshot if possible

### Submitting Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Test locally with `npm start`
4. Commit with a clear message describing the change
5. Open a PR against `main`

## Code Style

- No external CSS/JS frameworks — the frontend is a single HTML file
- Keep IPC handlers in `main.mjs`, expose them in `preload.cjs`
- Use CSS custom properties (variables) defined in `:root` for theming
- Korean UI labels for the widget interface, English for code and docs

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
