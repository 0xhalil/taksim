// The tool-building skill: before an agent builds a tool from bricks, it looks at the best product people
// already use for that need (k9s for Kubernetes, lazydocker for Docker, lnav for logs, …) and copies what
// makes it good: which facts it puts on the first screen, what it highlights, what one key press does.
// References here are a starting point; the agent may research others (web search, docs) and names the
// one it followed in the tool (reference), so the market shows what a tool was modeled on.

import { rank } from "./match.mjs";

export const REFERENCES = [
  { product: "k9s", url: "https://k9scli.io", keywords: ["kubernetes", "k8s", "kubectl", "pod", "cluster", "namespace", "deployment"],
    shows: ["pods with READY, STATUS, RESTARTS, AGE, node; problems colored", "CPU/MEM per pod vs requests/limits (kubectl top)", "live events of the namespace", "context and namespace always visible in the header"],
    actions: ["logs (and --previous) of a pod", "describe", "delete/restart pod (needs approval)", "port-forward", "shell into a pod (an exec session in the IDE, not a panel)"],
    lesson: "Everything is pinned to an explicit context and namespace; the one table that matters is pods, and red/amber rows are what the user scans for." },
  { product: "Lens", url: "https://k8slens.dev", keywords: ["kubernetes", "k8s", "cluster", "workload", "node"],
    shows: ["workload overview: deployments ready/desired", "node capacity and pressure", "warning events count"],
    actions: ["open logs", "scale deployment"], lesson: "An overview of counts (ready vs desired) before the detail table." },
  { product: "lazydocker", url: "https://github.com/jesseduffield/lazydocker", keywords: ["docker", "container", "compose", "image", "konteyner"],
    shows: ["containers with state, uptime, image, ports", "CPU and memory per container", "logs of the selected container", "compose services grouped by project"],
    actions: ["restart, stop, remove (approval)", "logs", "exec shell"], lesson: "State first; restarting/exited containers stand out; stats next to each container." },
  { product: "Portainer", url: "https://www.portainer.io", keywords: ["docker", "container", "stack", "volume"],
    shows: ["running/stopped/unhealthy counts", "stacks", "volumes and their size"], actions: ["recreate", "inspect"], lesson: "Counts by health as big numbers on top." },
  { product: "lnav", url: "https://lnav.org", keywords: ["log", "logs", "tail", "journal", "günlük", "error", "exception"],
    shows: ["log lines colored by level", "error/warning counts and their histogram over time", "a filtered view of only errors", "timestamps aligned"],
    actions: ["jump to next error", "explain a line"], lesson: "Parse level and timestamp out of each line; give errors their own view and a count." },
  { product: "Sentry", url: "https://sentry.io", keywords: ["error", "exception", "crash", "stack", "trace", "hata"],
    shows: ["errors grouped by message with count and last seen", "first stack frame"], actions: ["explain and find the code"], lesson: "Group repeated errors; a count per kind beats a wall of lines." },
  { product: "htop / btop", url: "https://htop.dev", keywords: ["process", "cpu", "memory", "load", "süreç", "yavaş", "top"],
    shows: ["processes sorted by CPU, then by memory", "load average and memory totals on top", "command names, not just pids"],
    actions: ["what is this process", "kill (approval)"], lesson: "Two sorts (CPU, memory) and the totals that tell whether the machine is actually busy." },
  { product: "duf / ncdu", url: "https://github.com/muesli/duf", keywords: ["disk", "df", "storage", "space", "volume", "alan"],
    shows: ["mounts with used %, colored when above 80/90%", "biggest directories (du)"], actions: ["what fills this mount"], lesson: "Real disks only (hide devfs/tmpfs); percent used is the column that matters." },
  { product: "lazygit / tig", url: "https://github.com/jesseduffield/lazygit", keywords: ["git", "commit", "branch", "diff", "repo", "status"],
    shows: ["branch with ahead/behind", "changed files by staged/unstaged/untracked", "recent commits with author and date"],
    actions: ["show diff of a file", "explain a commit"], lesson: "Branch state and ahead/behind on the first line." },
  { product: "pghero", url: "https://github.com/ankane/pghero", keywords: ["postgres", "postgresql", "psql", "pg", "sql", "query", "sorgu", "database", "veritabanı"],
    shows: ["slowest queries by total time (pg_stat_statements)", "active connections and long-running queries", "index usage, bloat, cache hit rate"],
    actions: ["explain a query", "cancel a long query (approval)"], lesson: "Rank queries by total time, not single runs; show long-running ones live." },
  { product: "Redis Insight", url: "https://redis.io/insight", keywords: ["redis", "cache", "keys", "memory"],
    shows: ["memory used vs max, hit rate, ops/sec", "connected clients", "slowlog"], actions: ["explain a slow command"], lesson: "INFO numbers as stats, slowlog as a table." },
  { product: "RabbitMQ management UI", url: "https://www.rabbitmq.com/docs/management", keywords: ["rabbitmq", "queue", "kuyruk", "amqp", "kafka", "consumer"],
    shows: ["queues with ready/unacked messages and consumers", "message rates", "queues with no consumers highlighted"], actions: ["purge (approval)", "explain backlog"],
    lesson: "Backlog (ready messages) and zero-consumer queues are the alarms." },
  { product: "GitHub Actions / Buildkite", url: "https://docs.github.com/actions", keywords: ["ci", "pipeline", "build", "workflow", "derleme", "deploy", "actions"],
    shows: ["latest runs with status, branch, duration", "failing job and its first error line"], actions: ["show the failing log", "re-run (approval)"],
    lesson: "Status per run with the failing step; the log of failures one click away (gh run list/view)." },
  { product: "Grafana", url: "https://grafana.com", keywords: ["metrics", "prometheus", "dashboard", "latency", "http", "endpoint", "api", "health"],
    shows: ["the few golden signals: rate, errors, latency (p95), saturation", "thresholds colored"], actions: ["explain a spike"],
    lesson: "Few big numbers with thresholds beat many charts; query Prometheus HTTP API for them." },
  { product: "Google Cloud console", url: "https://console.cloud.google.com", keywords: ["gcp", "gcloud", "google", "cloud run", "gke", "compute", "logging", "bulut"],
    shows: ["Cloud Run services with region, URL, latest ready revision", "GKE clusters with version, node count, status", "VM instances with zone, machine type, status, IPs", "Logs Explorer: entries colored by severity, newest first"],
    actions: ["describe a service or cluster", "read the logs of a revision", "explain an error entry"],
    lesson: "Pin --project (and region/zone); use --format=json so fields are exact; a status column colored by Ready/RUNNING is the first thing people scan." },
  { product: "Graphite / GitHub pull requests", url: "https://graphite.dev", keywords: ["pr", "pull request", "review", "inceleme", "merge", "github", "gh"],
    shows: ["open PRs by age with review state", "PRs waiting on review the longest first", "draft vs ready"], actions: ["summarize a PR", "who should review it"],
    lesson: "Age and review state are what move a queue; show how long each PR has waited, oldest first." },
  { product: "Swarmia / LinearB", url: "https://www.swarmia.com", keywords: ["team", "ekip", "activity", "commits", "author", "velocity", "manager", "yönetici"],
    shows: ["commits/PRs per person over a period", "activity per day", "work in progress"], actions: ["what did X work on"],
    lesson: "Trends over a period beat a single number; rank people gently and show the daily rhythm." },
  { product: "Argo CD / deploy dashboards", url: "https://argo-cd.readthedocs.io", keywords: ["deploy", "release", "rollout", "history", "dağıtım", "sürüm"],
    shows: ["deploys over time with status and duration", "what is running now", "failed deploys highlighted"], actions: ["what changed in this deploy", "roll back (approval)"],
    lesson: "A timeline of deploys with their outcome answers \"what changed and when\" at a glance." },
  { product: "Uptime Kuma", url: "https://github.com/louislam/uptime-kuma", keywords: ["uptime", "health", "endpoint", "url", "http", "ping", "monitor"],
    shows: ["each endpoint up/down with response time", "last failure"], actions: ["why is it down"], lesson: "One row per endpoint: status, latency, last checked." },
];

const asDoc = (r) => ({ id: r.product, name: r.product, summary: r.lesson, keywords: r.keywords, when: r.shows, spec: {} });

export function referencesFor(need, max = 3) {
  return rank(need, REFERENCES.map(asDoc)).slice(0, max).map((x) => REFERENCES.find((r) => r.product === x.tool.id));
}

export const STEPS = [
  "1. Name the need in one line (what the user wants to see or catch).",
  "2. Find the best product people already use for it. Start from the references below; if you can search the web or read docs, check what the current best tool is and what its main screen shows. If none fits, pick the closest professional tool you know.",
  "3. From it, list the 3-6 facts on its first screen and its alarms (what it colors red), the 2-4 actions people use most, and what people switch or drill into while using it (k9s: the namespace, a filter, a pod to see its logs). That is the feature list of your tool, not more.",
  "4. Map each fact to a source the machine has (CLI with machine-readable output: --format json, -o json, --porcelain; a file; a local HTTP API) and each alarm to a filtered source (where) shown as a stat with ok/warn_above/error_above.",
  "5. Build it with list_bricks + panel_open: big numbers for counts and alarms on top (stat, span 1), the main table (table with row_actions: ask for explanations, run only when the user wants changes), streams as log views. Show, don't tell: a chart for anything that changes over time (latency, CPU, error counts; x for rows with their own time), a timeline for durations and waiting (CI runs, deploys, PRs open), bars for rankings (restarts per pod, issues per person). Pin every command to explicit targets (context, namespace, host, file).",
  "5b. Make what people switch or drill into interactive (see list_bricks' interactive_example): a select for the target (namespace, environment, project), a slider for counts and cutoffs (top N, last N hours, slow-query threshold in ms), a text input with filter for search, a row input on the main table plus a detail view with when (pick a pod, see its logs or describe), and buttons (actions) for the actions people take most. Use {{in.<name>}} in the sources that follow them. For a database need, start from a schema explorer: a tables source (schema: \"tables\"), a select or row input for the table, a columns source (schema: \"columns\", table: \"{{in.t}}\"), then the query views.",
  "6. Check it with panel_read; fix parsing until the columns are right.",
  "7. Tell the user which product you modeled it on and what it shows. Once it works (panel_read shows the right data), save it yourself with save_tool when the need comes back (watching a service, a cluster, a queue, CI) — not a one-off investigation — with reference {product, url, borrowed: [the features you took]}, so the next agent finds it instead of building it again.",
];

export const DESIGN_TOOL = {
  name: "design_tool",
  description: "The tool-building skill: call it before building a new panel/tool from bricks (when find_tools has nothing that fits). Given the need, it returns the best-known products for it (e.g. k9s, lazydocker, lnav, pghero) with what their main screen shows, their alarms and key actions, plus the steps to turn that into a panel. Model your tool on the best one.",
  inputSchema: { type: "object", properties: { need: { type: "string", description: "what the user needs, e.g. \"watch RabbitMQ queues for backlog\"" } }, required: ["need"] },
  annotations: { readOnlyHint: true, destructiveHint: false },
};

export function designTool(need) {
  const refs = referencesFor(String(need || ""));
  return {
    need,
    steps: STEPS,
    references: refs.length ? refs : [],
    note: refs.length ? "Pick the reference that fits best (or a better one you know) and build its first screen." : "No reference here fits; find the best-known tool for this need yourself (web search or what you know) and follow the steps.",
  };
}
