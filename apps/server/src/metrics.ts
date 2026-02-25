import type { StorageRepository } from "@ohmyremote/storage";

const DURATION_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60];

function parseSummaryJson(value: string | null): {
  duration_ms?: number;
  bytes_in?: number;
  bytes_out?: number;
} {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value) as { duration_ms?: number; bytes_in?: number; bytes_out?: number };
  } catch {
    return {};
  }
}

function classifyTelegramType(payloadJson: string): string {
  try {
    const payload = JSON.parse(payloadJson) as { message?: unknown; callback_query?: unknown };
    if (payload.message) {
      return "message";
    }
    if (payload.callback_query) {
      return "callback_query";
    }
    return "other";
  } catch {
    return "other";
  }
}

function labels(parts: Record<string, string>): string {
  return Object.entries(parts)
    .map(([key, value]) => `${key}="${value.replace(/"/g, '\\"')}"`)
    .join(",");
}

export async function renderPrometheusMetrics(repository: StorageRepository): Promise<string> {
  const runs = await repository.listRuns(5000);
  const files = await repository.listFileRecords(5000);
  const inbox = await repository.listTelegramInbox(5000);

  const sessions = new Map<string, string>();
  for (const run of runs) {
    if (!sessions.has(run.sessionId)) {
      const session = await repository.getSessionById(run.sessionId);
      sessions.set(run.sessionId, session?.provider ?? "unknown");
    }
  }

  const runTotals = new Map<string, number>();
  const runDurationBucketCounts = new Map<string, number[]>();
  const runDurationSums = new Map<string, number>();
  const runDurationCounts = new Map<string, number>();
  const queueLatencyBucketCounts = Array<number>(DURATION_BUCKETS.length).fill(0);
  let queueLatencyInf = 0;
  let queueLatencySum = 0;
  let queueLatencyCount = 0;
  let inFlightRuns = 0;
  let queuedRuns = 0;

  for (const run of runs) {
    const engine = sessions.get(run.sessionId) ?? "unknown";
    const key = `${engine}|${run.status}`;
    runTotals.set(key, (runTotals.get(key) ?? 0) + 1);

    if (run.status === "in_flight") {
      inFlightRuns += 1;
    }
    if (run.status === "queued" || run.status === "leased") {
      queuedRuns += 1;
    }

    const summary = parseSummaryJson(run.summaryJson);
    const durationSeconds = Number(summary.duration_ms ?? 0) / 1000;
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      const buckets = runDurationBucketCounts.get(engine) ?? Array<number>(DURATION_BUCKETS.length).fill(0);
      for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
        if (durationSeconds <= DURATION_BUCKETS[i]) {
          buckets[i] += 1;
        }
      }
      runDurationBucketCounts.set(engine, buckets);
      runDurationSums.set(engine, (runDurationSums.get(engine) ?? 0) + durationSeconds);
      runDurationCounts.set(engine, (runDurationCounts.get(engine) ?? 0) + 1);
    }

    if (run.startedAt && run.createdAt && run.startedAt >= run.createdAt) {
      const latencySeconds = (run.startedAt - run.createdAt) / 1000;
      for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
        if (latencySeconds <= DURATION_BUCKETS[i]) {
          queueLatencyBucketCounts[i] += 1;
        }
      }
      queueLatencyInf += 1;
      queueLatencySum += latencySeconds;
      queueLatencyCount += 1;
    }
  }

  const fileBytesByDirection = new Map<string, number>();
  for (const file of files) {
    fileBytesByDirection.set(file.direction, (fileBytesByDirection.get(file.direction) ?? 0) + file.sizeBytes);
  }

  const telegramByType = new Map<string, number>();
  for (const row of inbox) {
    const type = classifyTelegramType(row.payloadJson);
    telegramByType.set(type, (telegramByType.get(type) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push("# HELP runs_total Total runs by engine and terminal status");
  lines.push("# TYPE runs_total counter");
  for (const [key, value] of runTotals.entries()) {
    const [engine, status] = key.split("|");
    lines.push(`runs_total{${labels({ engine, status })}} ${value}`);
  }

  lines.push("# HELP telegram_updates_total Total processed telegram updates by type");
  lines.push("# TYPE telegram_updates_total counter");
  for (const [type, value] of telegramByType.entries()) {
    lines.push(`telegram_updates_total{${labels({ type })}} ${value}`);
  }

  lines.push("# HELP file_bytes_total Total file bytes transferred by direction");
  lines.push("# TYPE file_bytes_total counter");
  for (const [direction, value] of fileBytesByDirection.entries()) {
    lines.push(`file_bytes_total{${labels({ direction })}} ${value}`);
  }

  lines.push("# HELP run_duration_seconds Run duration histogram by engine");
  lines.push("# TYPE run_duration_seconds histogram");
  for (const [engine, buckets] of runDurationBucketCounts.entries()) {
    for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
      lines.push(`run_duration_seconds_bucket{${labels({ engine, le: String(DURATION_BUCKETS[i]) })}} ${buckets[i]}`);
    }
    const count = runDurationCounts.get(engine) ?? 0;
    lines.push(`run_duration_seconds_bucket{${labels({ engine, le: "+Inf" })}} ${count}`);
    lines.push(`run_duration_seconds_sum{${labels({ engine })}} ${runDurationSums.get(engine) ?? 0}`);
    lines.push(`run_duration_seconds_count{${labels({ engine })}} ${count}`);
  }

  lines.push("# HELP queue_latency_seconds Job queue latency histogram");
  lines.push("# TYPE queue_latency_seconds histogram");
  for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
    lines.push(`queue_latency_seconds_bucket{${labels({ le: String(DURATION_BUCKETS[i]) })}} ${queueLatencyBucketCounts[i]}`);
  }
  lines.push(`queue_latency_seconds_bucket{${labels({ le: "+Inf" })}} ${queueLatencyInf}`);
  lines.push(`queue_latency_seconds_sum ${queueLatencySum}`);
  lines.push(`queue_latency_seconds_count ${queueLatencyCount}`);

  lines.push("# HELP in_flight_runs Number of in-flight runs");
  lines.push("# TYPE in_flight_runs gauge");
  lines.push(`in_flight_runs ${inFlightRuns}`);

  lines.push("# HELP queued_runs Number of queued runs");
  lines.push("# TYPE queued_runs gauge");
  lines.push(`queued_runs ${queuedRuns}`);

  return `${lines.join("\n")}\n`;
}
