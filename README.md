# usage-bars

A Claude Code mod that keeps your limits and context in view, as progress bars above the prompt:

```
5h       ████████████████░░░░░░░░░░░░░░░░░░░░░░░░   41%  ↻ 2h 14m
Weekly   ██████████████████████████████░░░░░░░░░░   76%  ↻ 3d 3h
Fable wk ████████████████████████████████████░░░░   92%  ↻ 3d 3h
Context  █▌███████████░░░░░░░░░░░░░░░░░░░░░▒▒▒▒▒▒   38%  76k/200k
         ■ System prompt 3k  ■ System tools 14k  ■ MCP tools 2k  ■ Messages 55k
```

- **5h**, **Weekly** and any per-model weekly window your account reports (e.g. Fable); windows the account doesn't have are not shown.
- Bars go **blue** while fine, **orange** from 70 %, **red** from 90 %.
- The context bar is split by category (system prompt, tools, MCP, memory, skills, messages…) in the same colours `/context` uses; `▒` is the autocompact buffer.

## Install

```
/plugin install usage-bars --marketplace PalmarHealer/claude-usage-bars
```

Answer `y` to add the marketplace, then pick the user scope.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
