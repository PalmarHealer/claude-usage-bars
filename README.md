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
- In narrow terminals the rows give up detail instead of wrapping: shorter bars, then the reset minutes, then the bar moves behind the label and percent (coloured background) to save its cells, then the reset times. The context row does the same: once its own bar no longer fits, `Context 12%` is drawn on the bar, then the token figures go; context categories that don't fit move to a second row.
- `/usage-bars` prints the raw figures the bars are drawn from.

## Settings

Under `/config` (or `/plugin` → usage-bars → configure); a change applies right away.

| Setting | Values | Default |
| --- | --- | --- |
| Layout | `auto` (label and percent move onto the bar only when there is no room), `compact` (always) | `auto` |
| Bar style | `solid` (filled cells), `glyphs` (block glyphs only, for terminals without background colours) | `solid` |
| Animation | `off`, `wave` (a light sweep across the filled part), `pulse` | `off` |
| Show the context row / the limits row | on, off | on |
| Show bars | off draws text only | on |
| Show percent | on, off (kept while bars are off) | on |
| Show context tokens / legend | on, off | on |
| Show reset times | on, off | on |
| Context bar colours | `categories` (as `/context`), `level` (one colour, the fill colour) | `categories` |
| Fill / warning / critical / empty colour | `#rrggbb` | `#5f87d7` / `#ffaf00` / `#ff5f5f` / `#4e4e4e` |
| Warning / critical level | percent | 70 / 90 |

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
