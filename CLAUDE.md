# CLAUDE.md

**perch** is a small MCP server for desktop control, written for Mamami. Goal:
five compact tools over a desktop server that does the real work, costing the
agent's context as little as possible. It drives the user's real desktop, so
every step that could show a window or reach another app is refused unless the
agent asked for it.

## Architecture

- `src/index.ts`: picks the backend by platform (Linux, Windows, else
  unsupported), serves stdio, exits when stdin ends. `perch
  setup-window-targeting` runs computer-use-linux's own setup command.
- `src/backend.ts`: the `Backend` interface. Tools call it with
  computer-use-linux's tool names and argument shapes. `linuxBackend` starts
  computer-use-linux as an MCP client on the first call and restarts it after
  it exits.
- `src/windows.ts`: the Windows backend. Answers the same tool names in
  computer-use-linux's shapes over open-computer-use's `op` command, one
  process per operation. Every request sets every gate itself
  (`gates()`), so the user's environment can't widen one.
- `src/upstream.ts`: zod shapes of computer-use-linux's answers, only the
  fields perch reads; everything else is ignored.
- `src/tools/{read,act}.ts`: the tools. The name prefix is the approval
  contract (`read_` looks, `act_` changes); `server.ts` marks `read_` tools
  read-only unless they set `raises`.
- `src/tools/types.ts`: the session perch keeps between calls: the last
  tree snapshot (e-refs), screenshot sizes and scales, known windows.
- `src/format/tree.ts`: a tree as indented lines `[e34 button "Save"]`;
  off-screen elements and unnamed containers left out.
- `src/png.ts`: decodes and shrinks the PNGs open-computer-use returns, so
  Windows screenshots fit `max_edge` like Linux ones.
- `src/server.ts`: registers the tools and serves its own `tools/list`
  without the SDK's `$schema` lines and `execution` fields.

## Conventions

- Tool names, parameters and env vars are a contract with mamami-ai
  (approval rules, skills): never rename or remove one in a 1.x release.
- Tokens matter: every byte of a tool description or schema is in every
  session. Say a thing once, in the tool description, not per field.
  `tests/server.test.ts` caps the tool list size.
- Results are short text: one line per window, element or step; failures
  carry the server's whole reason. Typed text is never echoed.
- Refusals happen before anything is sent, and say how to recover. A step
  that failed midway reports what already ran.
- Lookup tables keyed by names from apps or users use `Object.hasOwn`.
- Bug fixes start with a failing test. Tests use fake backends
  (`tests/helpers.ts`, `fakeRuntime` in `tests/windows.test.ts`); nothing
  touches the real desktop.

## Stack

TypeScript (strict, ESM), Node `>=22.12`, `@modelcontextprotocol/sdk`, `zod`,
`vitest`. Versions pinned exactly. The desktop servers
(`@agent-sh/computer-use-linux`, `@opensymph/open-computer-use`) are optional
dependencies, so an install on a platform one of them doesn't support still
succeeds.
