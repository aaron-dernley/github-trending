import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20260824.32";
import {
  buildSearchUrl,
  formatSearchDate,
  model,
  parseSearchResponse,
} from "./github_trending.ts";

function asContext<T>(context: unknown): T {
  return context as T;
}

const DEFAULT_GLOBAL_ARGS = {
  windowDays: 7,
  count: 10,
  language: undefined,
  githubToken: undefined,
};

// --- formatSearchDate / buildSearchUrl --------------------------------------

Deno.test("formatSearchDate formats as YYYY-MM-DD", () => {
  assertEquals(
    formatSearchDate(new Date("2026-08-28T13:45:00Z")),
    "2026-08-28",
  );
});

Deno.test("buildSearchUrl includes a created:> qualifier windowDays back", () => {
  const url = buildSearchUrl(
    7,
    10,
    undefined,
    new Date("2026-08-28T00:00:00Z"),
  );
  assert(
    url.includes("created%3A%3E2026-08-21") ||
      url.includes("created:>2026-08-21"),
  );
  assert(url.includes("sort=stars"));
  assert(url.includes("order=desc"));
  assert(url.includes("per_page=10"));
});

Deno.test("buildSearchUrl adds a language qualifier when provided", () => {
  const url = buildSearchUrl(
    7,
    10,
    "typescript",
    new Date("2026-08-28T00:00:00Z"),
  );
  const decoded = decodeURIComponent(url);
  assert(decoded.includes("language:typescript"));
});

Deno.test("buildSearchUrl omits the language qualifier when not provided", () => {
  const url = buildSearchUrl(
    7,
    10,
    undefined,
    new Date("2026-08-28T00:00:00Z"),
  );
  assert(!decodeURIComponent(url).includes("language:"));
});

// --- parseSearchResponse -----------------------------------------------------

// Trimmed from a real captured response, 2026-08-28.
const REAL_SEARCH_RESPONSE = JSON.stringify({
  total_count: 2355156,
  incomplete_results: false,
  items: [
    {
      full_name: "b-nnett/grok-bot-0.18-reconstructed",
      html_url: "https://github.com/b-nnett/grok-bot-0.18-reconstructed",
      stargazers_count: 3386,
      language: "TypeScript",
      description:
        "Unofficial source-oriented reconstruction and extension of Grok Bot 0.18.0 for macOS",
      created_at: "2026-08-23T20:53:01Z",
    },
    {
      full_name: "tobi/walgit",
      html_url: "https://github.com/tobi/walgit",
      stargazers_count: 2271,
      language: "Rust",
      description: null,
      created_at: "2026-08-23T22:28:01Z",
    },
  ],
});

Deno.test("parseSearchResponse parses a real captured response", () => {
  const items = parseSearchResponse(REAL_SEARCH_RESPONSE);
  assertEquals(items.length, 2);
  assertEquals(items[0].full_name, "b-nnett/grok-bot-0.18-reconstructed");
  assertEquals(items[1].description, null);
});

Deno.test("parseSearchResponse throws when items is missing/malformed", () => {
  let threw = false;
  try {
    parseSearchResponse('{"message": "API rate limit exceeded"}');
  } catch {
    threw = true;
  }
  assert(threw);
});

// --- snapshot -----------------------------------------------------------------

Deno.test("snapshot writes mapped repos sorted as GitHub returned them, plus totalMatching", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "snapshot",
  });

  await withMockedFetch(
    () => new Response(REAL_SEARCH_RESPONSE, { status: 200 }),
    () => model.methods.snapshot.execute({}, asContext(context)),
  );

  const data = getWrittenResources()[0].data as {
    repos: { fullName: string; stars: number; description: string | null }[];
    totalMatching: number;
    windowDays: number;
    language: string | null;
  };
  assertEquals(data.repos.length, 2);
  assertEquals(data.repos[0].fullName, "b-nnett/grok-bot-0.18-reconstructed");
  assertEquals(data.repos[0].stars, 3386);
  assertEquals(data.repos[1].description, null);
  assertEquals(data.totalMatching, 2355156);
  assertEquals(data.windowDays, 7);
  assertEquals(data.language, null);
});

Deno.test("snapshot sends an Authorization header when githubToken is set", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { ...DEFAULT_GLOBAL_ARGS, githubToken: "ghp_test123" },
    methodName: "snapshot",
  });

  let capturedHeaders: Headers | undefined;
  await withMockedFetch(
    (input: RequestInfo | URL, init?: RequestInit) => {
      // fetch() may be intercepted as either fetch(url, init) or as a
      // single already-constructed Request — handle both.
      capturedHeaders = input instanceof Request
        ? input.headers
        : new Headers(init?.headers);
      return new Response(REAL_SEARCH_RESPONSE, { status: 200 });
    },
    () => model.methods.snapshot.execute({}, asContext(context)),
  );

  assertEquals(capturedHeaders?.get("Authorization"), "Bearer ghp_test123");
  assertEquals(getWrittenResources().length, 1);
});

Deno.test("snapshot throws on a non-200 response (e.g. rate limited), writing nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "snapshot",
  });

  await assertRejects(
    () =>
      withMockedFetch(
        () =>
          new Response('{"message": "API rate limit exceeded"}', {
            status: 403,
          }),
        () => model.methods.snapshot.execute({}, asContext(context)),
      ).then((r) => r.result),
    Error,
    "403",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("snapshot records the language filter when one is set", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { ...DEFAULT_GLOBAL_ARGS, language: "rust" },
    methodName: "snapshot",
  });

  await withMockedFetch(
    () => new Response(REAL_SEARCH_RESPONSE, { status: 200 }),
    () => model.methods.snapshot.execute({}, asContext(context)),
  );

  const data = getWrittenResources()[0].data as { language: string | null };
  assertEquals(data.language, "rust");
});
