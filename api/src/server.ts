/**
 * HTTP surface (§7.5). State is in memory: twenty agents' results are a few KB
 * and the demo is a single session, so a database would only add failure modes.
 */
import { sha256Hex } from "@correlation/shared";
import Fastify, { type FastifyInstance } from "fastify";

import { config } from "./config.ts";
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
  evaluate: (policyId: number) => Promise<string>;
  policyView: (policyId: number) => Promise<unknown>;
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
    results: run.results.map((r) => ({
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

  app.get("/api/health", async () => ({
    ok: true,
    model: config.model,
    network: config.networkId,
    contract: config.contractId,
    signerConfigured: Boolean(config.signerAccountId && config.signerPrivateKey),
  }));

  app.post<{ Body: { mode?: "control" | "poisoned"; policyId?: number } }>(
    "/api/runs",
    async (request, reply) => {
      const mode = request.body?.mode ?? "control";
      if (mode !== "control" && mode !== "poisoned") {
        return reply.status(400).send({ error: "mode must be control or poisoned" });
      }
      const policyId = Number(request.body?.policyId ?? 1);
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
          run.results = await deps.runSwarm({
            policyId,
            windowStartNs: BigInt(Date.now()) * 1_000_000n,
            seed: policyId,
            poison: mode === "poisoned",
          });
          run.status = "complete";

          const accepted = run.results.filter((r) => r.signature);
          for (const result of accepted) {
            try {
              run.txHashes[result.agentId] = await deps.submitReceipt(result, policyId);
            } catch (error) {
              // A duplicate receipt is a success: the nullifier already recorded it.
              const message = error instanceof Error ? error.message : String(error);
              if (!/E05|DUPLICATE/.test(message)) {
                run.results[result.index]!.error = `E-submit: ${message.slice(0, 160)}`;
              }
            }
          }

          run.status = "evaluating";
          try {
            run.evaluateTx = await deps.evaluate(policyId);
            run.status = "triggered";
          } catch (error) {
            run.error = error instanceof Error ? error.message : String(error);
            run.status = "complete";
          }
        } catch (error) {
          run.error = error instanceof Error ? error.message : String(error);
          run.status = "error";
        }
      })();

      return reply.status(202).send({ runId: run.id });
    },
  );

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const run = runs.get(request.params.id);
    if (!run) return reply.status(404).send({ error: "unknown run" });
    return publicRun(run);
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
    evaluate: chain.evaluate,
    policyView: chain.policyView,
  });

  await app.listen({ port: config.port, host: "127.0.0.1" });
  process.stdout.write(`correlation api on http://127.0.0.1:${config.port}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
