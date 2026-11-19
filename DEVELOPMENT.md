# Developing perch

`CLAUDE.md` holds the architecture and the conventions. Read it before
changing behaviour.

## Commands

```sh
npm ci
npm run typecheck   # src and tests
npm test            # unit tests, no desktop needed
npm run build       # compile to build/; build/index.js is the server
```

Run all three before every commit. CI runs them on Linux and Windows.

## Windows end-to-end check

```sh
npm run build
node scripts/e2e-windows.mjs
```

Windows only, in a signed-in desktop session. It compiles a small WinForms
test app with the C# compiler built into Windows, drives it and Notepad (on a
new file of its own) through perch's five tools, prints every answer and its
time, and exits 1 if a check fails. It types into Notepad and kills the
Notepad process it started, so it refuses to start while another Notepad
window is open. CI runs it on `windows-latest`.

There is no Linux end-to-end check: it would drive your real windows.

## Moving to a new computer-use-linux or open-computer-use

1. Change the exact version in `package.json` (`optionalDependencies`) and run
   `npm install`.
2. `npm run typecheck && npm test`. `src/upstream.ts` names the fields perch
   reads from computer-use-linux; `src/windows.ts` the request and answer
   fields of open-computer-use's `op` command.
3. Try the five tools on a real desktop (Linux) or run the end-to-end check
   (Windows).
4. Update the "measured against" line in `README.md` and the changelog.

## Releasing

1. Bump the version in `package.json` and `src/version.ts` (a test keeps them
   equal), and date the changelog entry.
2. Commit, tag `vX.Y.Z`, push both.
3. `npm publish` (needs the `@redfoxxo` npm sign-in; `prepublishOnly` runs
   typecheck, tests and build).
