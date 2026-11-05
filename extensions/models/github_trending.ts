/**
 * Snapshots "trending" GitHub repos using only GitHub's official Search
 * API — repos created within a recent window, sorted by star count.
 *
 * GitHub does not publish an official trending API; the actual
 * github.com/trending page is unstable scraped HTML with no support
 * contract. This model deliberately avoids scraping it. "Recently
 * created, most-starred" is an honest, stable proxy for "trending" built
 * entirely on a documented, versioned API — not the same thing as
 * github.com/trending (which also weights recent star *velocity* on
 * older repos), but a defensible approximation that won't break silently
 * when GitHub redesigns a web page.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Minimal logger shape methods depend on — matches `context.logger`. */
export interface MinimalLogger {
  info(msg: string, props?: Record<string, unknown>): void;
  warn(msg: string, props?: Record<string, unknown>): void;
}

/** One repo entry as GitHub's search API returns it. */
export interface GitHubSearchItem {
  full_name: string;
  html_url: string;
  stargazers_count: number;
  language: string | null;
  description: string | null;
  created_at: string;
}

/** The shape of GitHub's `/search/repositories` response we actually use. */
export interface GitHubSearchResponse {
  total_count: number;
  items: GitHubSearchItem[];
}

/** Format a Date as YYYY-MM-DD, matching GitHub search's date-qualifier syntax. */
export function formatSearchDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Build the GitHub search API URL for "created within windowDays days,
 * sorted by stars descending," optionally filtered to one language.
 */
export function buildSearchUrl(
  windowDays: number,
  count: number,
  language: string | undefined,
  now: Date,
): string {
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const qParts = [`created:>${formatSearchDate(since)}`];
  if (language) qParts.push(`language:${language}`);
  const params = new URLSearchParams({
    q: qParts.join(" "),
    sort: "stars",
    order: "desc",
    per_page: String(count),
  });
  return `https://api.github.com/search/repositories?${params.toString()}`;
}

/** Parse and validate a GitHub search API response body. */
export function parseSearchResponse(raw: string): GitHubSearchItem[] {
  const parsed = JSON.parse(raw) as Partial<GitHubSearchResponse>;
  if (!Array.isArray(parsed.items)) {
    throw new Error(
      `Unexpected GitHub search response shape: ${raw.slice(0, 200)}`,
    );
  }
  return parsed.items;
}

const GlobalArgsSchema = z.object({
  windowDays: z.number().int().positive().default(7).describe(
    "How many days back to look for 'recently created' repos.",
  ),
  count: z.number().int().positive().max(100).default(10).describe(
    "How many repos to report, max 100 (a single GitHub search page).",
  ),
  language: z.string().optional().describe(
    "Optional language filter, e.g. 'typescript'. Omit for all languages.",
  ),
  githubToken: z.string().optional().meta({ sensitive: true }).describe(
    "Optional GitHub personal access token (no scopes needed) to raise the " +
      "search rate limit from 10/min unauthenticated to 30/min. Prefer a " +
      "vault reference over a plaintext value for real use.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const RepoSchema = z.object({
  fullName: z.string().describe("owner/repo."),
  url: z.string().describe("Repo's html_url."),
  stars: z.number().describe("stargazers_count at capture time."),
  language: z.string().nullable().describe(
    "Primary language, or null if GitHub reports none.",
  ),
  description: z.string().nullable(),
  createdAt: z.string().describe("Repo creation timestamp, ISO-8601."),
});

const TrendingSchema = z.object({
  repos: z.array(RepoSchema).describe(
    "Up to `count` repos, most-starred first.",
  ),
  windowDays: z.number().describe(
    "The recency window this snapshot was evaluated against.",
  ),
  language: z.string().nullable().describe(
    "The language filter applied, or null for all languages.",
  ),
  totalMatching: z.number().describe(
    "GitHub's total_count for the query — how many repos matched, not just how many were returned.",
  ),
  capturedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

interface MethodContext {
  globalArgs: GlobalArgs;
  logger: MinimalLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

/** Default textfile-collector path for `exportMetrics`. */
const DEFAULT_PROM_PATH =
  "/var/lib/prometheus/node-exporter/github-trending.prom";

/** Escape a Prometheus label value: backslash, then double quote. */
function promEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Render a `trending` snapshot as Prometheus text-exposition lines, in the
 * exact format run-via-serve.sh's inline Python wrote (the Fun Stuff
 * dashboard reads these names and labels). An empty snapshot omits the
 * top-repo series rather than guessing one.
 */
export function renderPrometheus(
  snapshot: {
    repos: Array<{ fullName: string; language: string | null; stars: number }>;
    totalMatching: number;
  },
): string {
  const out: string[] = [];
  const top = snapshot.repos[0];
  if (top) {
    out.push(
      "# HELP github_trending_top_repo_stars Star count of the top repo in the latest snapshot (recently-created, most-starred proxy for trending), labeled with the repo's name and language.",
      "# TYPE github_trending_top_repo_stars gauge",
      `github_trending_top_repo_stars{repo="${promEscape(top.fullName)}",` +
        `language="${promEscape(top.language ?? "")}"} ${top.stars}`,
    );
  }
  out.push(
    "# HELP github_trending_total_matching Total repos GitHub reports matching the snapshot query, not just the ones returned.",
    "# TYPE github_trending_total_matching gauge",
    `github_trending_total_matching ${snapshot.totalMatching}`,
  );
  return out.join("\n") + "\n";
}

/** Model definition for `@aaronge/github-trending`. */
export const model = {
  type: "@aaronge/github-trending",
  version: "2026.08.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    trending: {
      description:
        "Snapshot of recently-created, most-starred GitHub repos — an honest proxy for 'trending.'",
      schema: TrendingSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    snapshot: {
      description:
        "Fetch a fresh trending snapshot from GitHub's official search API.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { windowDays, count, language, githubToken } = context.globalArgs;
        const url = buildSearchUrl(windowDays, count, language, new Date());
        context.logger.info("Querying GitHub search: {url}", { url });

        const headers: Record<string, string> = {
          Accept: "application/vnd.github+json",
        };
        if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

        const resp = await fetch(url, { headers });
        const raw = await resp.text();
        if (!resp.ok) {
          throw new Error(
            `GitHub search failed (${resp.status}): ${raw.slice(0, 300)}`,
          );
        }
        const items = parseSearchResponse(raw);

        const repos = items.map((item) => ({
          fullName: item.full_name,
          url: item.html_url,
          stars: item.stargazers_count,
          language: item.language,
          description: item.description,
          createdAt: item.created_at,
        }));

        context.logger.info(
          "Captured {repoCount} repos, top: {topRepo} ({topStars} stars)",
          {
            repoCount: repos.length,
            topRepo: repos[0]?.fullName,
            topStars: repos[0]?.stars,
          },
        );

        const totalMatching =
          (JSON.parse(raw) as GitHubSearchResponse).total_count;
        const handle = await context.writeResource("trending", "trending", {
          repos,
          windowDays,
          language: language ?? null,
          totalMatching,
          capturedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    exportMetrics: {
      description:
        "Write the latest snapshot's top repo and total match count as a " +
        "Prometheus textfile-collector file. Written atomically (tmp file + " +
        "rename) since node_exporter may be reading the directory " +
        "concurrently. Throws if there is no snapshot yet, leaving any " +
        "existing file alone. Writes no swamp data.",
      arguments: z.object({
        path: z.string().default(DEFAULT_PROM_PATH).describe(
          "Destination .prom file inside node_exporter's textfile directory.",
        ),
      }),
      execute: async (args: { path: string }, context: MethodContext) => {
        const raw = await context.readResource("trending");
        const parsed = TrendingSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(
            "No valid trending snapshot to export — run snapshot first.",
          );
        }
        const body = renderPrometheus(parsed.data);
        const dir = args.path.slice(0, args.path.lastIndexOf("/")) || ".";
        const base = args.path.slice(args.path.lastIndexOf("/") + 1);
        const tmp = await Deno.makeTempFile({ dir, prefix: `.${base}.` });
        try {
          await Deno.writeTextFile(tmp, body);
          await Deno.chmod(tmp, 0o644);
          await Deno.rename(tmp, args.path);
        } catch (err) {
          await Deno.remove(tmp).catch(() => {});
          throw err;
        }
        context.logger.info("Wrote {path}", { path: args.path });
        return { dataHandles: [] };
      },
    },
  },
};
