import { useCallback, useEffect, useMemo, useState } from "react";

import {
  claimPayout,
  fetchPolicy,
  fetchRun,
  startRun,
  type AgentRow,
  type PolicyResponse,
  type RunResponse,
} from "./api.ts";
import { bpsToPercent, formatNear, shortAccount, shortHash } from "./format.ts";

const POLICY_ID = 1;

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
  const [policy, setPolicy] = useState<PolicyResponse | null>(null);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimTx, setClaimTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPolicy = useCallback(async () => {
    try {
      setPolicy(await fetchPolicy(POLICY_ID));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void loadPolicy();
    const timer = setInterval(() => void loadPolicy(), 3000);
    return () => clearInterval(timer);
  }, [loadPolicy]);

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
    setBusy(true);
    setError(null);
    try {
      const runId = await startRun(mode, POLICY_ID);
      setRun(await fetchRun(runId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const pay = async () => {
    setClaiming(true);
    setError(null);
    try {
      setClaimTx(await claimPayout(POLICY_ID));
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

  return (
    <main>
      <header>
        <div>
          <h1>Correlation</h1>
          <p className="muted">Parametric cover for correlated agent failure</p>
        </div>
        <div className="controls">
          <span className="badge">● testnet</span>
          <button disabled={busy || running} onClick={() => void launch("control")}>
            Run control
          </button>
          <button disabled={busy || running} onClick={() => void launch("poisoned")}>
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

      <div className="columns">
        <Panel title={`Policy p-${String(POLICY_ID).padStart(3, "0")} · ${status}`}>
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
