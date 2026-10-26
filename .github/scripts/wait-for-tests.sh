#!/bin/sh
# Waits for the `test` workflow to pass on this commit (up to 30 minutes): a release builds while the tests run and
# publishes only once they passed. Needs GH_TOKEN, GITHUB_REPOSITORY and SHA.
for i in $(seq 1 60); do
  runs=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/test.yml/runs?head_sha=$SHA&per_page=20" \
    --jq '[.workflow_runs[] | .conclusion // "pending"] | join(" ")')
  case " $runs " in *" success "*) echo "tests passed on $SHA"; exit 0 ;; esac
  case " $runs " in *" pending "*) ;; *"  "*) [ "$i" -gt 6 ] && break ;; *) echo "tests did not pass on $SHA: $runs" >&2; exit 1 ;; esac
  sleep 30
done
echo "no passing test run for $SHA" >&2; exit 1
