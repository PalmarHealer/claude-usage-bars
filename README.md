# usage-bars

Just another usage bar plugin. A Claude Code mod that keeps your limits and context in view.

Above the prompt, the context window split by category:

```
Context  ██████████▒▒░░░░░░░░░░░░░░░░░░░░  12%  121k/1M   ■ System prompt 2k  ■ System tools 38k  ■ Skills 6k  ■ Messages 73k
```

Under the prompt, the limits side by side after the footer hint:

```
(shift+tab to cycle)  ·  5h ████████░░░░ 41%  ↻ 2h 14m  │  Weekly █████████░░░ 76%  ↻ 3d 3h  │  Fable ███████████░ 92%  ↻ 3d 3h
```

- **5h**, **Weekly** and every per-model weekly window your account has (e.g. Fable), read from the account's usage endpoint; the engine sets the credential, the mod never sees it.
- Bars go **blue** while fine, **orange** from 70 %, **red** from 90 %.
- The context bar uses the colours `/context` uses; `▒` is the autocompact buffer.
- In narrow terminals the rows give up detail instead of wrapping: shorter bars, then the reset times, then the bars (percent only); context categories that don't fit move to a second row.
- `/usage-bars` prints the raw figures the bars are drawn from.

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

## License

[GPL-3.0](LICENSE)
