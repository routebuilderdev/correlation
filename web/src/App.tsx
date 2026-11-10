import { useCallback, useEffect, useMemo, useState } from "react";

import {
  claimPayout,
  fetchHealth,
  fetchPolicy,
  fetchRun,
  startRun,
  type AgentRow,
  type PolicyResponse,
  type RunResponse,
} from "./api.ts";
import { bpsToPercent, formatNear, shortAccount, shortHash } from "./format.ts";

/**
 * Which policy the page drives.
 *
 * `?policy=N` wins, otherwise the newest policy the contract holds: a demo buys
 * a new policy each time, and a hardcoded id filmed a dead one while the run
 * wrote to a live one.
 */
function requestedPolicy(): number | null {
  const raw = new URLSearchParams(window.location.search).get("policy");
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** `?run=run-…` renders a finished run from api/.runs without driving the model. */
function requestedRun(): string | null {
  const raw = new URLSearchParams(window.location.search).get("run");
  return raw && /^run-[a-z0-9-]{1,64}$/.test(raw) ? raw : null;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Gauge({ failed, started, triggerBps }: { failed: number; started: number; triggerBps: number }) {
  const bps = started === 0 ? 0 : Math.round((failed / started) * 10_000);
  const width = Math.min(100, bps / 100);
  const crossed = started > 0 && bps >= triggerBps;
  return (
    <div className="gauge">
      <div className="gauge-value">
        {started === 0 ? "—" : bpsToPercent(bps)}
        <span className={crossed ? "tag triggered" : "tag"}>{crossed ? "TRIGGERED" : "below"}</span>
      </div>
      <div className="bar">
        <div className={crossed ? "fill crossed" : "fill"} style={{ width: `${width}%` }} />
        <div className="marker" style={{ left: `${Math.min(100, triggerBps / 100)}%` }} />
      </div>
      <div className="muted">
        threshold {bpsToPercent(triggerBps)} · failed {failed} / started {started}
      </div>
    </div>
  );
}

function SwarmGrid({ results }: { results: AgentRow[] }) {
  const cells = useMemo(() => {
    const byIndex = new Map(results.map((r) => [r.index, r]));
    return Array.from({ length: 20 }, (_, index) => byIndex.get(index) ?? null);
  }, [results]);

  return (
    <div className="grid">
      {cells.map((cell, index) =>
        cell === null ? (
          <div key={index} className="cell pending" title={`agent-${index + 1} not run`}>
            {String(index + 1).padStart(2, "0")}
          </div>
        ) : (
          <div
            key={index}
            className={cell.ok ? "cell pass" : cell.error ? "cell error" : "cell fail"}
            title={`${cell.agentId} · n=${cell.n} · a=${cell.answer ?? "—"} · expected ${cell.expected}${cell.error ? ` · ${cell.error}` : ""}`}
          >
            {String(index + 1).padStart(2, "0")} {cell.ok ? "✓" : "✗"}
          </div>
        ),
      )}
    </div>
  );
}

function ReceiptTable({ results }: { results: AgentRow[] }) {
  const rows = results.filter((r) => r.completionId !== null);
  if (rows.length === 0) return <p className="muted">No receipts yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>agent</th>
          <th>verdict</th>
          <th>n</th>
          <th>a</th>
          <th>req</th>
          <th>res</th>
          <th>sig</th>
          <th>tx</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.agentId} className={row.ok ? "" : "bad"}>
            <td>{row.agentId}</td>
            <td>{row.ok ? "correct" : (row.error ?? "wrong answer")}</td>
            <td>{row.n}</td>
            <td>{row.answer ?? "—"}</td>
            <td title={row.requestSha256 ?? ""}>{shortHash(row.requestSha256)}</td>
            <td title={row.responseSha256 ?? ""}>{shortHash(row.responseSha256)}</td>
            <td title={row.signingPublicKey ?? ""}>{row.signatureKind ?? "—"}</td>
            <td title={row.txHash ?? ""}>{row.txHash ? shortHash(row.txHash, 5) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function App() {
  const [policyId, setPolicyId] = useState<number | null>(requestedPolicy());
  const [policy, setPolicy] = useState<PolicyResponse | null>(null);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimTx, setClaimTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPolicy = useCallback(async () => {
    if (policyId === null) return;
    try {
      setPolicy(await fetchPolicy(policyId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [policyId]);

  // The contract names the policy, not the browser: ask once, then poll views.
  useEffect(() => {
    if (policyId !== null) return;
    void (async () => {
      try {
        const health = await fetchHealth();
        setPolicyId(health.policyId ?? 1);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setPolicyId(1);
      }
    })();
  }, [policyId]);

  useEffect(() => {
    void loadPolicy();
    const timer = setInterval(() => void loadPolicy(), 3000);
    return () => clearInterval(timer);
  }, [loadPolicy]);

  // Demo-day fallback: a recorded run renders exactly as it did live.
  useEffect(() => {
    const id = requestedRun();
    if (!id) return;
    void (async () => {
      try {
        setRun(await fetchRun(id));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, []);

  useEffect(() => {
    if (!run || run.status === "triggered" || run.status === "error") return;
    const timer = setInterval(async () => {
      try {
        setRun(await fetchRun(run.id));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [run]);

  const launch = async (mode: "control" | "poisoned") => {
    if (policyId === null) return;
    setBusy(true);
    setError(null);
    try {
      const runId = await startRun(mode, policyId);
      setRun(await fetchRun(runId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const pay = async () => {
    if (policyId === null) return;
    setClaiming(true);
    setError(null);
    try {
      setClaimTx(await claimPayout(policyId));
      await loadPolicy();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setClaiming(false);
    }
  };

  const view = policy?.policy;
  const pool = policy?.pool;
  const status = run?.status ?? view?.status?.toLowerCase() ?? "idle";
  const running = status === "running" || status === "evaluating";
  // Receipts only count inside an open window: a run against a spent policy
  // posts twenty transactions and cannot trigger.
  const open = view === undefined || view.status === "Active";

  return (
    <main>
      <header>
        <div>
          <h1>Correlation</h1>
          <p className="muted">Parametric cover for correlated agent failure</p>
        </div>
        <div className="controls">
          <span className="badge">● testnet</span>
          <button disabled={busy || running || !open} onClick={() => void launch("control")}>
            Run control
          </button>
          <button disabled={busy || running || !open} onClick={() => void launch("poisoned")}>
            Run poisoned
          </button>
          {view?.status === "Triggered" ? (
            <button className="pay" disabled={claiming} onClick={() => void pay()}>
              {claiming ? "Claiming…" : "Claim payout"}
            </button>
          ) : null}
        </div>
      </header>

      {error ? <p className="alert">{error}</p> : null}
      {view && !open ? (
        <p className="alert">
          p-{String(policyId).padStart(3, "0")} is {view.status.toLowerCase()} — this window is
          closed. Buy a new policy with <code>npm run seed --workspace @correlation/api</code>.
        </p>
      ) : null}

      <div className="columns">
        <Panel title={`Policy p-${String(policyId ?? 0).padStart(3, "0")} · ${status}`}>
          {view ? (
            <>
              <Row label="limit" value={`${formatNear(view.limit)} NEAR`} />
              <Row label="premium" value={`${formatNear(view.premium)} NEAR`} />
              <Row
                label="window"
                value={`${Math.round((view.window_end_ns - view.window_start_ns) / 6e10)} min`}
              />
              <Row label="model" value={view.model_id} />
              <Row label="signer" value={shortHash(view.signer_pubkey, 6)} />
              <Row label="buyer" value={shortAccount(view.buyer)} />
              <Row label="terms hash" value={shortHash(view.terms_hash, 6)} />
              <Row label="paid" value={`${formatNear(view.paid_amount)} NEAR`} />
              {claimTx ? <Row label="claim tx" value={shortHash(claimTx, 6)} /> : null}
            </>
          ) : (
            <p className="muted">Loading contract view…</p>
          )}
        </Panel>

        <Panel title="Index">
          <Gauge
            failed={view?.failed ?? 0}
            started={view?.started ?? 0}
            triggerBps={view?.trigger_bps ?? 2500}
          />
          {pool ? (
            <>
              <Row label="pool total" value={`${formatNear(pool.total)} NEAR`} />
              <Row label="available" value={`${formatNear(pool.available)} NEAR`} />
              <Row label="committed" value={`${formatNear(pool.committed)} NEAR`} />
            </>
          ) : null}
          {run?.evaluateTx ? <Row label="evaluate tx" value={shortHash(run.evaluateTx, 6)} /> : null}
        </Panel>
      </div>

      <Panel title={`Swarm (${run?.results.length ?? 0} / 20)`}>
        <SwarmGrid results={run?.results ?? []} />
      </Panel>

      <Panel title="Receipts">
        <ReceiptTable results={run?.results ?? []} />
      </Panel>

      <footer className="muted">
        Prototype · testnet · no real funds · index-based, not indemnity
      </footer>
    </main>
  );
}
