# taksim website

Self-contained pages: no build step, no framework. `index.html` plays the session and makes no outside requests;
`download/index.html` is the download page (disk image, Homebrew, GitHub) and asks GitHub's public API once for the latest
version, size and date; without it the button goes to the releases page.
The main page plays a short taksim session on its own (an orchestrator gets a job, builds its team,
the agents talk, a group keeps its notes, the IDE docks, a tool builds itself and raises
an alarm) and offers the download.

## Look at it

Open `site/index.html` in a browser. To see the static final state, turn on
"Reduce motion" in macOS (System Settings > Accessibility > Display).

## Keep it true to the app

The canvas on the page copies the native app, measure for measure:

| On the page | Comes from |
| --- | --- |
| node title bar, status ring, arrows, link labels | `native/Sources/Taksim/GraphDraw.swift` |
| colours (IntelliJ Dark / Light) | `native/Sources/Taksim/Theme.swift` |
| chat and composer | `native/Sources/Taksim/Chat/` |
| panel, stat / table / timeline / log bricks | `native/Sources/Taksim/PanelChrome.swift`, `Bricks/` |
| docked IDE | `native/Sources/Taksim/IDE/IDEView.swift`, `IDEDock.swift` |
| CLI logos | `native/Sources/Taksim/Logos.swift` |

When the app's look changes, change the page with it. The logos are copied by a script:

```bash
npm run site:logos
```

To compare against the real thing, render the app's canvas without a server
(the design notes in `docs/design-language.md` list every snapshot option):

```bash
TAKSIM_SNAPSHOT_CANVAS=canvas.json TAKSIM_SNAPSHOT=/tmp/canvas.png TAKSIM_SNAPSHOT_DARK=1 native/build/Taksim.app/Contents/MacOS/Taksim
```

## Languages

English by default, Simplified Chinese from the 中文 switch (or a Chinese browser).
Story text goes through `t()`; add its translation to the `ZH` table. The app's own labels
(Chat, Agent, panel bricks, code) stay in English, as the app draws them.

## Links

- GitHub: `https://github.com/0xhalil/taksim`
- Download for Mac: `/download/`, the page with the Download button (the newest disk image, read from GitHub's API),
  the Homebrew command and the GitHub links. The home page's button goes there.

Both start working once the repository and its first release exist.

## Publish

The site lives at https://taksim.dev, served by nginx on our own server.
`.github/workflows/site.yml` sends the pages (`index.html`, `download/`) there over SSH on every push to `main` that
touches `site/`, then fetches both pages to check them. `README.md`, `scripts/` and `drafts/` are not sent.

The deploy key can do one thing: on the server its `authorized_keys` entry is
`restrict,command="…/deploy.sh"`, a script that reads a tar of the site from stdin, refuses anything but plain
html/css/js/image/json/text files (no links, no hidden files, no `..`, 20 MB at most), checks that `index.html` is the
taksim page and swaps the pages in. The repository holds the secrets `DEPLOY_KEY`, `DEPLOY_HOST`, `DEPLOY_USER` and
`DEPLOY_KNOWN_HOSTS`.

## Drafts

`drafts/` holds earlier design explorations. They are not published.
