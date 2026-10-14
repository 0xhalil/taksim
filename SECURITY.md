# Security

taksim runs agent CLIs, terminals and commands on your machine, so security reports matter a lot.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead: the **Security** tab of this repository
› **Report a vulnerability**. Include what an attacker can do, the steps to reproduce it and the version you tested.
You'll get an answer within a week.

## What's in scope

- Anything that lets a web page, another user or another process drive the engine (it should accept only local
  requests from the app; see the Security section of the [README](README.md)).
- Ways around panel approvals, the credential-file block, folder limits of the IDE and panels, or read-only modes.
- The updater: anything that could make the app install something other than a release published here.

Bugs in the agent CLIs themselves belong to their projects.
