# AGENTS.md — GitHub Actions

Downstream contract: every lane in this repository runs on a standard GitHub-hosted runner — `ubuntu-latest`, plus `windows-latest` for the native Windows lane — with no organization-scoped pools, repository variables, or Actions secrets. Upstream's enterprise runner pools, self-hosted standby drills, and org-Project Issue workflows are not part of this repository; `.github/issue-management/` stays as the label and Issue-status policy library its tests exercise.

`ci.yml` is pull-request-only and owns the verdict: `node 24 / static`, `node 24 / coverage`, `node 24 / snapshots and artifacts`, the `node-compat` matrix (22.19 and 26), `python 3.10 / keyless SDK`, `python runtime / release-shaped Linux x64`, and the required Wine `windows` lane; `all-checks-passed` aggregates exactly those and fails on any skipped member. `windows-native` runs the complete native gate inventory on `windows-latest` and reports independently, so it never delays that verdict.

`ci-master.yml` runs on push to `main` and on dispatch: it seeds the Wine apt cache for the pull-request lane and runs the post-merge build, unit tests, and static gates on `ubuntu-latest`. `e2e.yml` and `release.yml` are manual-only here: the e2e suites need a `DEEPSEEK_API_KEY` this repository does not hold, and the pack job verifies a packed install through a publishing toolchain it does not wire up. `release-vendor.yml` keeps its pull-request trigger.

Run jobs that target Windows under native `pwsh`; the Wine lane is the deliberate exception, and it is the only Windows signal inside the required verdict.
