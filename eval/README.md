# Does orchestration pay off?

This folder measures one question: on **our kind of work**, is the result better with "create agents" on than with a
single agent? Tuning the prompt without this measurement is guessing.

## Tasks

One JSON file per task under `tasks/`:

| Field | What |
|---|---|
| `id`, `title` | the task's name |
| `repo` | the repository the task starts from (the runner copies it for every run and never touches the original) |
| `prompt` | the request to the agent, as you would really write it |
| `checks` | shell commands proving the work is done; all must exit 0 |

Files with `"example": true` are skipped. Aim for about 20 real tasks from past work whose checks can be written as
commands (tests, builds, `grep`). The mix matters: a one-file fix, a change across several files, work that needs
research, work with independent parts.

## Running

```bash
node eval/run.mjs --server http://127.0.0.1:8787 --model sonnet
```

Every task runs twice: `single` (switch off) and `orchestrated` (switch on). It connects to a running engine, so it
uses your accounts and **spends real tokens**. The orchestrator's approval question is answered "Start", a failed
part's question "Stop".

## Results

Per mode: tasks passed, in how many tasks the work was really split (`split`), average tokens and time. Details in
`eval/results.json`. Three things to look at:

1. Does the orchestrated mode pass more tasks? If not, the switch should stay off by default and the prompt should
   say "don't split".
2. Does it split where splitting isn't needed (`split` high, same pass rate)? Then the prompt is too eager.
3. Tokens per passed task: does the gain cover the cost?

With few tasks, small differences are noise; trust only large ones.
