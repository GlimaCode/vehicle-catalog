# Contributing

This is a [GlimaCode](https://glimacode.com) project — a two-developer studio.
This guide documents how we work, so the code stays consistent no matter which
of us touches it.

## Who maintains this

- [Ali Ahmadi](https://github.com/aliahmadi1382)
- [Mostafa Taghipour](https://github.com/MoStafaMTP)

External contributions are welcome as issues and pull requests, though we may
be slow to review — this is a working studio, not a community project.

## Commit identity

Each developer commits under their own GitHub identity, using a `noreply`
address so personal email never lands in public history:

```bash
git config --global user.name "Your Name"
git config --global user.email "<id>+<username>@users.noreply.github.com"
```

Your `<id>+<username>` address is listed at
[github.com/settings/emails](https://github.com/settings/emails).

## Branches

- `main` is always deployable.
- Work on a descriptive branch: `feat/csv-import`, `fix/year-range-off-by-one`,
  `docs/readme-setup`.
- Force-pushing to `main` and deleting `main` are blocked at the repository
  level — this is deliberate.

## Commit messages

Short imperative subject, no trailing period, under ~70 characters:

```
add year-range validation to the rules engine
fix off-by-one in variation parent lookup
document the evidence gate in findings.mjs
```

If the why isn't obvious from the subject, add a body paragraph explaining the
reasoning — not the mechanics. The diff already shows what changed.

## Code style

- **TypeScript/JavaScript** — existing project conventions win over personal
  preference. If a file uses one style, match it.
- **Comments explain why, not what.** A comment restating the code is noise; a
  comment explaining a non-obvious decision is the most valuable line in the
  file.
- **No dead code.** Delete it — git remembers.
- **No secrets, ever.** No API keys, tokens, passwords, or real customer data.
  `.env.example` holds placeholders only (`<password>`, never a real value).

## Before you push

```bash
npm test          # where the project has tests — must stay green
```

Check the diff for anything that shouldn't be public: credentials, internal
company names, real export data, personal identifiers.

## Pull requests

For anything beyond a typo, open a PR — even solo. It gives the other developer
a place to comment and leaves a record of the reasoning.

Describe **what changed and why**, and note anything you deliberately left out
of scope.

## Reporting a security issue

Do not open a public issue. Email **glimacode.studio@gmail.com** — see the
organization [security policy](https://github.com/GlimaCode/.github/blob/main/SECURITY.md).
