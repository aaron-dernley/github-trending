# @aaronge/github-trending

Snapshots "trending" GitHub repos — recently-created repos sorted by
star count — using only GitHub's official, documented Search API.

**Scope, honestly stated**: GitHub does not publish an official trending
API. The real `github.com/trending` page is unstable scraped HTML with
no support contract, and also factors in recent star *velocity* on older
repos, which this model doesn't attempt to replicate. "Recently created,
most-starred" is a defensible, stable proxy for "trending" built entirely
on a documented API — not a scrape, so it won't break silently when
GitHub redesigns a web page. It's not identical to the real trending
page.

## Installation

```sh
swamp extension pull @aaronge/github-trending
```

## Usage

```sh
swamp model create @aaronge/github-trending daily

swamp model method run daily snapshot
```

Writes one resource, `trending` — up to `count` repos (most-starred
first) created within the last `windowDays` days, plus GitHub's own
`total_count` for how many repos matched overall.

## Global arguments

| Arg           | Default | Notes                                                                                     |
| ------------- | -------- | -------------------------------------------------------------------------------------------- |
| `windowDays`  | `7`     | How many days back counts as "recently created."                                            |
| `count`       | `10`    | How many repos to report, max 100 (a single GitHub search page).                             |
| `language`    | _(none)_ | Optional language filter, e.g. `typescript`.                                                |
| `githubToken` | _(none)_ | Optional personal access token (no scopes needed) — raises the search rate limit from 10/min unauthenticated to 30/min. Prefer a vault reference over a plaintext value for real use. |

## How it works

- **`snapshot`** — queries `GET
  /search/repositories?q=created:>{date}[+language:{lang}]&sort=stars&order=desc`,
  maps the top `count` results, and writes `trending`. Throws (writing
  nothing) on a non-200 response — e.g. a 403 from hitting the
  unauthenticated rate limit — rather than writing a partial/stale
  snapshot silently.

**Rate limits**: GitHub's search endpoint allows 10 requests/minute
unauthenticated, 30/minute with any token. Polling a few times a day is
plenty for "what's trending" — there's no reason to run this every
minute.

- **`exportMetrics`** — writes the latest snapshot's top repo (labeled
  with its name and language) and total match count as a Prometheus
  textfile-collector file, `/var/lib/prometheus/node-exporter/github-trending.prom`
  by default (`--input path=...` to change it). Written atomically (tmp
  file + rename). Throws if there's no snapshot yet. Writes no swamp data.

## Workflow

The `@aaronge/github-trending` workflow ships in the package, so
`swamp extension pull @aaronge/github-trending` brings it along. It carries
its own `trigger.schedule` (`20 */3 * * *`), so a running `swamp serve`
takes a snapshot every 3 hours and then runs `exportMetrics`. The export
only runs after a successful snapshot.

The consuming repo needs a `daily` model instance:

```bash
swamp model create @aaronge/github-trending daily
swamp workflow run @aaronge/github-trending   # one manual run
```

To change the cadence without editing the package:
`swamp workflow trigger set @aaronge/github-trending --schedule "20 */6 * * *"`.

The old `run-via-serve.sh` wrapper, which ran `snapshot` from a systemd
timer through a throwaway `swamp serve` and wrote the textfile with inline
Python, was removed on 2026-11-05. The shipped workflow replaces it.

## License

MIT — see LICENSE for details.
