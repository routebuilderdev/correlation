/**
 * HTTP surface (§7.5). State is in memory: twenty agents' results are a few KB
 * and the demo is a single session, so a database would only add failure modes.
 */
import { sha256Hex } from "@correlation/shared";
import Fastify, { type FastifyInstance } from "fastify";

import { config } from "./config.ts";
import { latestRunFor, loadRun, saveRun } from "./store.ts";
import { runSwarm, type AgentResult, type SwarmOptions } from "./swarm/agents.ts";

export interface Run {
  id: string;
  policyId: number;
  mode: "control" | "poisoned";
  status: "running" | "complete" | "evaluating" | "triggered" | "error";
  startedAt: string;
  error: string | null;
  results: AgentResult[];
  txHashes: Record<string, string>;
  evaluateTx: string | null;
}

export interface Deps {
  runSwarm: (options: SwarmOptions) => Promise<AgentResult[]>;
  submitReceipt: (result: AgentResult, policyId: number) => Promise<string>;
  /** Asks the contract, after a failed send, whether the receipt landed anyway. */
  receiptPosted?: (policyId: number, agentId: string) => Promise<boolean>;
  evaluate: (policyId: number) => Promise<string>;
  claim: (policyId: number) => Promise<string>;
  policyView: (policyId: number) => Promise<unknown>;
  /** The policy a request means when it names none. Optional for tests. */
  latestPolicyId?: () => Promise<number>;
}

const runs = new Map<string, Run>();

function publicRun(run: Run) {
  return {
    id: run.id,
    policyId: run.policyId,
    mode: run.mode,
    status: run.status,
    startedAt: run.startedAt,
    error: run.error,
    evaluateTx: run.evaluateTx,
    txHashes: run.txHashes,
    results: run.results
      .filter((r): r is AgentResult => Boolean(r))
      .map((r) => ({
      index: r.index,
      agentId: r.agentId,
      n: r.n,
      expected: r.expected,
      answer: r.answer,
      ok: r.ok,
      error: r.error,
      completionId: r.completionId,
      signatureKind: r.signature?.signature_kind ?? null,
      signingAddress: r.signature?.signing_address ?? null,
      requestSha256: r.requestBytes.length ? sha256Hex(r.requestBytes) : null,
      responseSha256: r.responseBytes.length ? sha256Hex(r.responseBytes) : null,
      signature: r.signature?.signature ?? null,
      signingPublicKey: r.signature?.signing_public_key ?? null,
      txHash: run.txHashes[r.agentId] ?? null,
    })),
  };
}

export function buildServer(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-headers", "content-type");
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
    if (request.method === "OPTIONS") return reply.status(204).send();
  });

  /**
   * What the contract says about a policy, as a run status.
   *
   * `evaluate` returns successfully whether or not the index crossed the
   * trigger — it records the index either way. Labelling every finished
   * evaluate "triggered" put the word next to a 0% gauge on the control arm,
   * which contradicts the chain the whole demo is about. Anything unreadable is
   * "complete": a run must never claim a payout the chain did not make.
   */
  const chainStatus = async (policyId: number): Promise<Run["status"]> => {
    try {
      const view = (await deps.policyView(policyId)) as { policy?: { status?: unknown } } | null;
      return view?.policy?.status === "Triggered" ? "triggered" : "complete";
    } catch {
      return "complete";
    }
  };

  /** A caller that names no policy gets the newest one on the contract. */
  const resolvePolicyId = async (requested?: number): Promise<number> => {
    if (requested !== undefined && Number.isInteger(requested) && requested > 0) return requested;
    if (deps.latestPolicyId) {
      try {
        return await deps.latestPolicyId();
      } catch {
        // Fall through to 1: a chain hiccup must not stop the page loading.
      }
    }
    return 1;
  };

  app.get("/api/health", async () => {
    let policyId: number | null = null;
    let policyError: string | null = null;
    try {
      policyId = deps.latestPolicyId ? await deps.latestPolicyId() : null;
    } catch (error) {
      // Health is the page's first call: say why the policy is unknown instead
      // of hiding a broken RPC behind a spinner.
      policyError = error instanceof Error ? error.message : String(error);
    }
    return {
      ok: true,
      model: config.model,
      network: config.networkId,
      contract: config.contractId,
      signerConfigured: Boolean(config.signerAccountId && config.signerPrivateKey),
      policyId,
      policyError,
    };
  });

  app.post<{ Body: { mode?: "control" | "poisoned"; policyId?: number } }>(
    "/api/runs",
    async (request, reply) => {
      const mode = request.body?.mode ?? "control";
      if (mode !== "control" && mode !== "poisoned") {
        return reply.status(400).send({ error: "mode must be control or poisoned" });
      }
      const policyId = await resolvePolicyId(request.body?.policyId);
      const run: Run = {
        id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        policyId,
        mode,
        status: "running",
        startedAt: new Date().toISOString(),
        error: null,
        results: [],
        txHashes: {},
        evaluateTx: null,
      };
      runs.set(run.id, run);

      // Fire and forget: the UI polls. A judge must see cells fill in.
      void (async () => {
        try {
          // Post each receipt the moment its agent settles, so the on-chain
          // index climbs while the arm is running instead of jumping once at
          // the end. The contract's nullifier (policy_id, agent_id,
          // window_start_ns) is a natural idempotency key: repeating a post is
          // safe, and E14 DUPLICATE proves the first one landed. Retrying an
          // ambiguous send is therefore the correct move, not a risky one.
          const posting = new Map<string, Promise<void>>();
          const post = (result: AgentResult): Promise<void> => {
            if (!result.signature) return Promise.resolve();
            const already = posting.get(result.agentId);
            if (already) return already;
            const attempt = (async () => {
              try {
                run.txHashes[result.agentId] = await deps.submitReceipt(result, policyId);
                // A later attempt landed: the earlier "E-submit" line is history,
                // not the receipt's state. "wrong answer" is the receipt's own
                // verdict and stays.
                if (run.results[result.index]?.error?.startsWith("E-submit:")) {
                  run.results[result.index]!.error = null;
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                // A send that failed on the wire may still have landed, and the
                // contract's rejections are all opaque `WebAssembly trap`s, so
                // ask the chain instead of reading the error string.
                const landed = await deps
                  .receiptPosted?.(policyId, result.agentId)
                  .catch(() => false);
                if (!landed && !/E14|E05|DUPLICATE/.test(message)) {
                  run.results[result.index]!.error = `E-submit: ${message.slice(0, 160)}`;
                }
              } finally {
                posting.delete(result.agentId);
              }
            })();
            posting.set(result.agentId, attempt);
            return attempt;
          };

          run.results = await deps.runSwarm({
            policyId,
            windowStartNs: BigInt(Date.now()) * 1_000_000n,
            seed: policyId,
            poison: mode === "poisoned",
            // Publish each cell the moment it settles: a judge watching the
            // page should see twenty results arrive, not one jump at the end.
            onAgent: (result) => {
              run.results[result.index] = result;
              void post(result);
            },
          });
          await Promise.all([...posting.values()]);

          // One more pass over anything still unposted. A missing receipt is a
          // real failure; a duplicate is not, so the retry cannot hurt.
          for (const result of run.results) {
            if (result?.signature && !run.txHashes[result.agentId]) await post(result);
          }
          await Promise.all([...posting.values()]);
          run.status = "complete";

          run.status = "evaluating";
          try {
            run.evaluateTx = await deps.evaluate(policyId);
            run.status = await chainStatus(policyId);
          } catch (error) {
            run.error = error instanceof Error ? error.message : String(error);
            run.status = "complete";
          }
        } catch (error) {
          run.error = error instanceof Error ? error.message : String(error);
          run.status = "error";
        } finally {
          // Survives the process: a recorded run is the demo-day fallback.
          await saveRun(run.id, publicRun(run));
        }
      })();

      return reply.status(202).send({ runId: run.id });
    },
  );

  /** The final step a judge clicks: triggered -> paid. */
  app.post<{ Body: { policyId?: number } }>("/api/claim", async (request, reply) => {
    const policyId = await resolvePolicyId(request.body?.policyId);
    try {
      return { txHash: await deps.claim(policyId) };
    } catch (error) {
      return reply.status(502).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /** Optional progress stream (§7.5): same shape as the poll, pushed. */
  app.get<{ Params: { id: string } }>("/api/runs/:id/stream", (request, reply) => {
    const run = runs.get(request.params.id);
    if (!run) return reply.status(404).send({ error: "unknown run" });

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });

    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const send = () => {
      reply.raw.write(`data: ${JSON.stringify(publicRun(run))}\n\n`);
      if (run.status === "triggered" || run.status === "complete" || run.status === "error") {
        stop();
        reply.raw.end();
      }
    };

    timer = setInterval(send, 500);
    request.raw.on("close", stop);
    send();
    return reply;
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const run = runs.get(request.params.id);
    if (run) return publicRun(run);
    const recorded = await loadRun<unknown>(request.params.id);
    if (!recorded) return reply.status(404).send({ error: "unknown run" });
    return recorded;
  });

  // What a reload shows: the newest run recorded for this policy, live one
  // first so a page opened mid-run keeps following it.
  app.get<{ Params: { id: string } }>("/api/policy/:id/run", async (request, reply) => {
    const policyId = Number(request.params.id);
    if (!Number.isInteger(policyId) || policyId <= 0) {
      return reply.status(400).send({ error: "policy id must be a positive integer" });
    }
    const live = [...runs.values()]
      .filter((run) => run.policyId === policyId)
      .sort((left, right) => (left.startedAt > right.startedAt ? -1 : 1))[0];
    if (live) return publicRun(live);
    const recorded = await latestRunFor<unknown>(policyId);
    if (!recorded) return reply.status(404).send({ error: "no run recorded for this policy" });
    return recorded;
  });

  app.get<{ Params: { id: string } }>("/api/policy/:id", async (request, reply) => {
    const policyId = Number(request.params.id);
    if (!Number.isInteger(policyId) || policyId <= 0) {
      return reply.status(400).send({ error: "policy id must be a positive integer" });
    }
    try {
      return await deps.policyView(policyId);
    } catch (error) {
      return reply.status(502).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return app;
}

async function main(): Promise<void> {
  const chain = await import("./chain/index.ts");
  const app = buildServer({
    runSwarm,
    submitReceipt: async (result, policyId) =>
      chain.postReceipt({
        policyId,
        agentId: result.agentId,
        requestBytes: result.requestBytes,
        responseBytes: result.responseBytes,
        signatureJson: JSON.stringify(result.signature),
      }),
    receiptPosted: chain.receiptPosted,
    evaluate: chain.evaluate,
    claim: chain.claim,
    policyView: chain.policyView,
    latestPolicyId: chain.latestPolicyId,
  });

  await app.listen({ port: config.port, host: "127.0.0.1" });
  process.stdout.write(`correlation api on http://127.0.0.1:${config.port}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
