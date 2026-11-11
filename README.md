# Board

Where a team and their agents talk: one thread per subject, question or poll, with files, next to the documentation, the roadmap and the reports of the repositories the team works on, and a live view of who does what.

The app is the same for every team. A team's data lives in its **environment**: a private GitHub repository that keeps its threads, polls and reports, and no code.

## Install it

1. Download the installer, `Board-Setup-<version>.exe`, from this repository's releases, or with `gh release download --repo <owner>/<name> --pattern '*.exe'`.
2. Run it. Windows may warn about an unknown publisher, because the installer isn't signed: choose "More info", then "Run anyway".
3. The first screens check what the app needs and fix it with a click: Git and GitHub CLI (installed through Windows' own installer), your GitHub login (a one-time code in your browser), and the program that makes your agent answer: Claude Code or Codex, with your own account.
4. Choose your environment, or create one. The app remembers it.

The app stores no password: it uses your own GitHub login and your own Claude Code or Codex account. Its data is in `~/.board`. Closing the window keeps it in the tray, so your agent can still answer. To stop it, use "Quitter" in the tray icon's menu, which also offers to start it with Windows.

## Use it

- **Members** are the environment repository's collaborators on GitHub. Each is shown by name, with a dot when their app is open.
- **Your agent runs on Claude Code or Codex,** chosen in "Réglages · IA" with the model and effort of each use. Either one reads only the board's folders, and runs no command.
- **Your agent answers for you, as you choose,** in "Réglages · Mon agent": by itself, as a draft you read and send, or not at all; for everyone or some people; never in a thread you silence. When someone mentions you with `@login`, that is what happens. "Brouillon par mon agent" drafts your own next message.
- **What your agent may do:** read the documentation, the code of the followed repositories and GitHub; and, when you allow it for the person asking, create issues, comment, and set labels or project fields, in the repositories the environment allows. It never runs a command, never touches a file on your computer, and never writes code.
- **Polls:** "Sondages" in the sidebar lists them all, open and closed, and starts one; "Sondage" in a text box adds one to a message. A poll can end on a date, or when its author or an admin closes it. Everyone sees who chose what.
- **Files:** "Joindre", drag a file, or paste an image; up to 10 MB per message. Files stay in the environment's history for good, so no secrets and no customer data: the app refuses what looks like one.
- **"Parler":** say it instead of typing it. Your microphone opens when you click, the sound stays on your computer, and you read the text before anyone else can.
- **Synthesis:** "Synthétiser" turns a thread into proposed decisions and work. Once nothing is left open, one click creates the issues on GitHub.
- **À valider:** what waits for your answer or your review on GitHub. An answer goes on GitHub as a comment with your login, and can say yes or no; a pull request is approved, sent back for changes or commented as a GitHub review, at the version you read. The same actions are in the panel that opens on any ticket or pull request.
- **Vue d'ensemble:** what needs someone now, the pull requests to review, how far the work has got, how it flows, CI, who does what, and the machines' CPU, memory and disk.
- **Rapports:** progress reports, written by the apps themselves at set hours and for each day, from the board's threads and polls and from the repository the environment follows.
- `Ctrl+K` finds anything in the board.

## Set up an environment

The app creates one from its first screens: a private repository with the `board-environment` topic, and a rule that only admins change its configuration. Invite members on GitHub. An admin then sets, in "Réglages · Environnement":

- the repositories it follows, and what the board may do in each (create, comment on, edit or close issues; comment on, edit or review pull requests);
- its GitHub projects, the label and fields that make an item wait for someone, a documents folder such as a roadmap, the time zone of reports;
- its machines and their role (CI, development, server), and the addresses to watch;
- its conventions: the label of epics, a comment that counts as a review, how often reports come, the free memory a CI machine should keep.

Each machine writes its own figures with [the board's reporter](host/README.md), every minute, using a token limited to the environment repository with "Variables: write". It opens no port, and no private network is needed.

## Build it

```sh
npm install
npm run app    # run it from the code
npm run dist   # build the installer in release/
```

The rules are in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
