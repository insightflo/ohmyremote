import { useEffect, useMemo, useState } from "react";

interface Project {
  id: string;
  name: string;
  rootPath: string;
  defaultEngine: string;
}

interface Session {
  id: string;
  projectId: string;
  provider: string;
  createdAt: number;
}

interface Run {
  id: string;
  projectId: string;
  sessionId: string;
  status: string;
  startedAt?: number;
  finishedAt?: number;
  summary?: {
    duration_ms?: number;
    tool_calls_count?: number;
    bytes_in?: number;
    bytes_out?: number;
    exit_status?: string;
  } | null;
}

interface RunEvent {
  id: string;
  seq: number;
  eventType: string;
  payloadJson: string;
}

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ok"; data: T };

function usePathname(): [string, (to: string) => void] {
  const [pathname, setPathname] = useState(window.location.pathname || "/");

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname || "/");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = (to: string) => {
    if (to === pathname) {
      return;
    }

    window.history.pushState({}, "", to);
    setPathname(to);
  };

  return [pathname, navigate];
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function link(onNavigate: (to: string) => void, to: string) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onNavigate(to);
  };
}

function PageFrame(props: { title: string; children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: 24, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
      <h1 style={{ marginBottom: 12 }}>{props.title}</h1>
      {props.children}
    </main>
  );
}

function ErrorBanner(props: { text: string }) {
  return (
    <div role="alert" style={{ border: "1px solid #f66", padding: 12, background: "#fff5f5", marginBottom: 12 }}>
      {props.text}
    </div>
  );
}

function MetricsWidgets(props: { runs: Run[] }) {
  const metrics = useMemo(() => {
    if (props.runs.length === 0) {
      return { successRate: 0, medianDuration: 0, toolCallsPerRun: 0, bytesTransferred: 0 };
    }

    const success = props.runs.filter((run) => run.status === "completed").length;
    const successRate = Math.round((success / props.runs.length) * 100);
    const durations = props.runs
      .map((run) => Number(run.summary?.duration_ms ?? 0))
      .filter((duration) => Number.isFinite(duration))
      .sort((a, b) => a - b);
    const medianDuration = durations.length === 0 ? 0 : durations[Math.floor(durations.length / 2)];
    const totalToolCalls = props.runs.reduce((acc, run) => acc + Number(run.summary?.tool_calls_count ?? 0), 0);
    const toolCallsPerRun = Math.round((totalToolCalls / props.runs.length) * 100) / 100;
    const bytesTransferred = props.runs.reduce(
      (acc, run) => acc + Number(run.summary?.bytes_in ?? 0) + Number(run.summary?.bytes_out ?? 0),
      0
    );

    return { successRate, medianDuration, toolCallsPerRun, bytesTransferred };
  }, [props.runs]);

  return (
    <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, margin: "16px 0" }}>
      <MetricCard label="Success Rate" value={`${metrics.successRate}%`} />
      <MetricCard label="Median Duration" value={`${metrics.medianDuration} ms`} />
      <MetricCard label="Tool Calls / Run" value={`${metrics.toolCallsPerRun}`} />
      <MetricCard label="Bytes Transferred" value={`${metrics.bytesTransferred}`} />
    </section>
  );
}

function MetricCard(props: { label: string; value: string }) {
  return (
    <article style={{ border: "1px solid #ddd", borderRadius: 6, padding: 12 }}>
      <div style={{ fontSize: 12, color: "#666" }}>{props.label}</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{props.value}</div>
    </article>
  );
}

function ProjectsPage(props: { onNavigate: (to: string) => void }) {
  const [state, setState] = useState<LoadState<Project[]>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void fetchJson<Project[]>("/api/projects")
      .then((data) => {
        if (!cancelled) {
          setState({ status: "ok", data });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: "error", error: String(error) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PageFrame title="Projects">
      {state.status === "loading" && <p>Loading projects...</p>}
      {state.status === "error" && <ErrorBanner text={`Failed to load projects: ${state.error}`} />}
      {state.status === "ok" && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th align="left">Name</th>
              <th align="left">Root Path</th>
              <th align="left">Default Engine</th>
            </tr>
          </thead>
          <tbody>
            {state.data.map((project) => (
              <tr key={project.id} style={{ borderTop: "1px solid #eee" }}>
                <td>
                  <a href={`/projects/${project.id}`} onClick={link(props.onNavigate, `/projects/${project.id}`)}>
                    {project.name}
                  </a>
                </td>
                <td>{project.rootPath}</td>
                <td>{project.defaultEngine}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PageFrame>
  );
}

function ProjectSessionsPage(props: { projectId: string; onNavigate: (to: string) => void }) {
  const [state, setState] = useState<LoadState<Session[]>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void fetchJson<Session[]>(`/api/sessions?project_id=${encodeURIComponent(props.projectId)}`)
      .then((data) => {
        if (!cancelled) {
          setState({ status: "ok", data });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: "error", error: String(error) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [props.projectId]);

  return (
    <PageFrame title={`Sessions for ${props.projectId}`}>
      <p>
        <a href="/" onClick={link(props.onNavigate, "/")}>Back to projects</a>
      </p>
      {state.status === "loading" && <p>Loading sessions...</p>}
      {state.status === "error" && <ErrorBanner text={`Failed to load sessions: ${state.error}`} />}
      {state.status === "ok" && (
        <ul>
          {state.data.map((session) => (
            <li key={session.id}>
              <a href={`/sessions/${session.id}`} onClick={link(props.onNavigate, `/sessions/${session.id}`)}>
                {session.id}
              </a>{" "}
              ({session.provider})
            </li>
          ))}
        </ul>
      )}
    </PageFrame>
  );
}

function SessionRunsPage(props: { sessionId: string; onNavigate: (to: string) => void }) {
  const [state, setState] = useState<LoadState<Run[]>>({ status: "loading" });
  const [projectIdInput, setProjectIdInput] = useState("");
  const [runText, setRunText] = useState("run from dashboard");

  const refresh = () => {
    void fetchJson<Run[]>(`/api/runs?session_id=${encodeURIComponent(props.sessionId)}&limit=100`)
      .then((data) => {
        setState({ status: "ok", data });
        if (data[0]?.projectId) {
          setProjectIdInput(data[0].projectId);
        }
      })
      .catch((error: unknown) => setState({ status: "error", error: String(error) }));
  };

  useEffect(() => {
    refresh();
  }, [props.sessionId]);

  const onCreateRun = async () => {
    if (!projectIdInput) {
      return;
    }

    await fetchJson<{ runId: string }>("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        projectId: projectIdInput,
        sessionId: props.sessionId,
        idempotencyKey: `web:${Date.now()}`,
        prompt: runText,
      }),
    });
    refresh();
  };

  return (
    <PageFrame title={`Runs for ${props.sessionId}`}>
      <p>
        <a href="/" onClick={link(props.onNavigate, "/")}>Back to projects</a>
      </p>
      {state.status === "loading" && <p>Loading runs...</p>}
      {state.status === "error" && <ErrorBanner text={`Failed to load runs: ${state.error}`} />}
      {state.status === "ok" && (
        <>
          <MetricsWidgets runs={state.data} />
          <section style={{ margin: "16px 0", border: "1px solid #eee", padding: 12 }}>
            <h2 style={{ marginTop: 0 }}>Start Run</h2>
            <label>
              Project ID
              <input value={projectIdInput} onChange={(event) => setProjectIdInput(event.target.value)} style={{ width: "100%" }} />
            </label>
            <label>
              Prompt
              <textarea value={runText} onChange={(event) => setRunText(event.target.value)} style={{ width: "100%", minHeight: 64 }} />
            </label>
            <button type="button" onClick={onCreateRun}>Start run</button>
          </section>

          <ul>
            {state.data.map((run) => (
              <li key={run.id}>
                <a href={`/runs/${run.id}`} onClick={link(props.onNavigate, `/runs/${run.id}`)}>
                  {run.id}
                </a>{" "}
                status={run.status}
              </li>
            ))}
          </ul>
        </>
      )}
    </PageFrame>
  );
}

function RunDetailPage(props: { runId: string; onNavigate: (to: string) => void }) {
  const [runState, setRunState] = useState<LoadState<Run>>({ status: "loading" });
  const [eventsState, setEventsState] = useState<LoadState<RunEvent[]>>({ status: "loading" });
  const [filter, setFilter] = useState("all");

  const refresh = () => {
    void fetchJson<Run>(`/api/runs/${encodeURIComponent(props.runId)}`)
      .then((data) => setRunState({ status: "ok", data }))
      .catch((error: unknown) => setRunState({ status: "error", error: String(error) }));

    void fetchJson<RunEvent[]>(`/api/runs/${encodeURIComponent(props.runId)}/events`)
      .then((data) => setEventsState({ status: "ok", data }))
      .catch((error: unknown) => setEventsState({ status: "error", error: String(error) }));
  };

  useEffect(() => {
    refresh();
  }, [props.runId]);

  const onCancel = async () => {
    await fetchJson<{ ok: boolean }>(`/api/runs/${encodeURIComponent(props.runId)}/cancel`, { method: "POST", body: JSON.stringify({}) });
    refresh();
  };

  const filteredEvents = useMemo(() => {
    if (eventsState.status !== "ok") {
      return [];
    }

    if (filter === "all") {
      return eventsState.data;
    }

    return eventsState.data.filter((event) => event.eventType === filter);
  }, [eventsState, filter]);

  return (
    <PageFrame title={`Run ${props.runId}`}>
      <p>
        <a href="/" onClick={link(props.onNavigate, "/")}>Back to projects</a>
      </p>
      {runState.status === "error" && <ErrorBanner text={`Failed to load run: ${runState.error}`} />}
      {eventsState.status === "error" && <ErrorBanner text={`Failed to load events: ${eventsState.error}`} />}
      {runState.status === "ok" && (
        <section style={{ marginBottom: 12 }}>
          <div>status={runState.data.status}</div>
          <button type="button" onClick={onCancel}>Cancel run</button>
        </section>
      )}

      <label>
        Event filter
        <select value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">all</option>
          <option value="run_started">run_started</option>
          <option value="text_delta">text_delta</option>
          <option value="tool_start">tool_start</option>
          <option value="tool_end">tool_end</option>
          <option value="error">error</option>
          <option value="run_finished">run_finished</option>
        </select>
      </label>

      {eventsState.status === "loading" && <p>Loading events...</p>}
      {eventsState.status === "ok" && (
        <ol>
          {filteredEvents.map((event) => (
            <li key={event.id}>
              #{event.seq} {event.eventType}
            </li>
          ))}
        </ol>
      )}
    </PageFrame>
  );
}

function parsePath(pathname: string):
  | { page: "projects" }
  | { page: "project"; projectId: string }
  | { page: "session"; sessionId: string }
  | { page: "run"; runId: string } {
  const projectMatch = pathname.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) {
    return { page: "project", projectId: decodeURIComponent(projectMatch[1]) };
  }

  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    return { page: "session", sessionId: decodeURIComponent(sessionMatch[1]) };
  }

  const runMatch = pathname.match(/^\/runs\/([^/]+)$/);
  if (runMatch) {
    return { page: "run", runId: decodeURIComponent(runMatch[1]) };
  }

  return { page: "projects" };
}

export function App() {
  const [pathname, navigate] = usePathname();
  const route = parsePath(pathname);

  if (route.page === "project") {
    return <ProjectSessionsPage projectId={route.projectId} onNavigate={navigate} />;
  }

  if (route.page === "session") {
    return <SessionRunsPage sessionId={route.sessionId} onNavigate={navigate} />;
  }

  if (route.page === "run") {
    return <RunDetailPage runId={route.runId} onNavigate={navigate} />;
  }

  return <ProjectsPage onNavigate={navigate} />;
}
