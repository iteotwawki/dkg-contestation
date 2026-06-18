/**
 * The framework-agnostic transport contract.
 *
 * This is the seam that keeps the protocol portable: the contestation engine
 * speaks only `DkgTransport`. Hermes, OpenClaw, an MCP client, or a raw HTTP
 * client each provide an implementation. `HttpDkgTransport` below is the
 * reference implementation against the verified DKG v10 rc.17 HTTP API.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Quad } from './types.js';

export interface SealInfo {
  merkleRoot?: string;
  authorAddress?: string;
}

/** Minimal surface the engine needs from a DKG node. */
export interface DkgTransport {
  /** The caller's agent address (0x...). */
  agentAddress(): Promise<string>;
  /** Ensure a (local-only) context graph exists. Idempotent. */
  ensureContextGraph(id: string, name?: string): Promise<void>;
  /** Create a named WM assertion. Idempotent-ish (tolerates already-exists). */
  createAssertion(contextGraphId: string, name: string): Promise<void>;
  /** Append quads to a WM assertion. Returns count written. */
  writeQuads(contextGraphId: string, name: string, quads: Quad[]): Promise<number>;
  /** Seal the WM draft (EIP-712 AuthorAttestation). Returns seal info. */
  finalize(contextGraphId: string, name: string): Promise<SealInfo>;
  /** Share a WM assertion to SWM (gossip-replicated). */
  share(contextGraphId: string, name: string): Promise<void>;
  /** Read every quad in a WM assertion. */
  readQuads(contextGraphId: string, name: string): Promise<Quad[]>;
  /**
   * Fetch an assertion's lifecycle state (memory layer + promotion status).
   * Used to prove a share succeeded without re-reading the (now-empty) WM draft.
   */
  getAssetState(contextGraphId: string, name: string): Promise<AssetState>;
  /** Endorse a claim ("I vouch for this"). Maps to the endorsed tier. */
  endorse?(contextGraphId: string, name: string): Promise<void>;
}

/** Lifecycle snapshot of a knowledge assertion on the node. */
export interface AssetState {
  /** e.g. 'WM' | 'SWM'. */
  memoryLayer?: string;
  /** e.g. 'created' | 'promoted'. */
  state?: string;
  /** SWM assertion graph IRI once promoted. */
  assertionGraph?: string;
  /** The reserved UAL the node minted for this assertion. */
  reservedUal?: string;
}

export interface HttpDkgTransportOptions {
  baseUrl?: string;
  /** Explicit token; otherwise read from `${dkgHome}/auth.token`. */
  authToken?: string;
  /** DKG_HOME; used to discover auth.token when authToken is absent. */
  dkgHome?: string;
  fetchImpl?: typeof fetch;
  /**
   * Per-request timeout in ms. A DKG v10 node couples context-graph creation
   * and SWM share to P2P sync, so individual calls can legitimately take
   * ~10–15s on a cold/syncing node. We default to 30s — generous enough for a
   * syncing node, but bounded so a wedged call fails fast with a clear error
   * instead of hanging the caller (and any adapter client) forever.
   */
  timeoutMs?: number;
}

export class HttpDkgTransport implements DkgTransport {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private cachedAddress?: string;

  constructor(opts: HttpDkgTransportOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:9200').replace(/\/$/, '');
    this.token = opts.authToken ?? HttpDkgTransport.discoverToken(opts.dkgHome);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Read the daemon token. The auth.token file has a leading comment line
   * (`# DKG node API token — ...`) above the token — take the last non-comment,
   * non-blank line (the em-dash in the comment otherwise poisons the header).
   */
  static discoverToken(dkgHome?: string): string {
    const home = dkgHome ?? process.env.DKG_HOME;
    if (!home) {
      throw new Error('No authToken and no DKG_HOME to discover auth.token from.');
    }
    const raw = readFileSync(join(home, 'auth.token'), 'utf8');
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    const token = lines.at(-1);
    if (!token) throw new Error(`auth.token at ${home} had no token line.`);
    return token;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `${method} ${path} timed out after ${this.timeoutMs}ms ` +
            `(node may be mid-sync; raise timeoutMs if this is expected).`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* leave as text */
    }
    return { status: res.status, body: parsed as T };
  }

  async agentAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress;
    const { status, body } = await this.req<{ agentAddress: string }>('GET', '/api/agent/identity');
    if (status !== 200 || !body?.agentAddress) {
      throw new Error(`identity failed: HTTP ${status}`);
    }
    this.cachedAddress = body.agentAddress;
    return body.agentAddress;
  }

  async ensureContextGraph(id: string, name?: string): Promise<void> {
    const { status, body } = await this.req<{ message?: string }>(
      'POST',
      '/api/context-graph/create',
      { id, name: name ?? id },
    );
    // 200 = created; a conflict/already-exists is fine for our idempotent intent.
    if (status === 200 || status === 201 || status === 409) return;
    const msg = (body as { message?: string })?.message ?? '';
    if (/exist/i.test(msg)) return;
    throw new Error(`ensureContextGraph(${id}) failed: HTTP ${status} ${msg}`);
  }

  async createAssertion(contextGraphId: string, name: string): Promise<void> {
    const { status, body } = await this.req<{ alreadyExists?: boolean; message?: string }>(
      'POST',
      '/api/knowledge-assets',
      { contextGraphId, name },
    );
    if (status === 200 || status === 201) return;
    const msg = (body as { message?: string })?.message ?? '';
    if (/exist/i.test(msg)) return;
    throw new Error(`createAssertion(${name}) failed: HTTP ${status} ${msg}`);
  }

  async writeQuads(contextGraphId: string, name: string, quads: Quad[]): Promise<number> {
    const { status, body } = await this.req<{ written?: number }>(
      'POST',
      `/api/knowledge-assets/${encodeURIComponent(name)}/wm/write`,
      { contextGraphId, quads },
    );
    if (status !== 200) throw new Error(`writeQuads(${name}) failed: HTTP ${status}`);
    return body?.written ?? quads.length;
  }

  async finalize(contextGraphId: string, name: string): Promise<SealInfo> {
    const { status, body } = await this.req<SealInfo>(
      'POST',
      `/api/knowledge-assets/${encodeURIComponent(name)}/wm/finalize`,
      { contextGraphId },
    );
    if (status !== 200) throw new Error(`finalize(${name}) failed: HTTP ${status}`);
    return { merkleRoot: body?.merkleRoot, authorAddress: body?.authorAddress };
  }

  async share(contextGraphId: string, name: string): Promise<void> {
    const { status } = await this.req(
      'POST',
      `/api/knowledge-assets/${encodeURIComponent(name)}/swm/share`,
      { contextGraphId, entities: 'all' },
    );
    if (status !== 200) throw new Error(`share(${name}) failed: HTTP ${status}`);
  }

  async readQuads(contextGraphId: string, name: string): Promise<Quad[]> {
    const qs = `?contextGraphId=${encodeURIComponent(contextGraphId)}`;
    const { status, body } = await this.req<{ quads?: Quad[] }>(
      'GET',
      `/api/knowledge-assets/${encodeURIComponent(name)}/wm/quads${qs}`,
    );
    if (status !== 200) throw new Error(`readQuads(${name}) failed: HTTP ${status}`);
    return (body?.quads ?? []).map((q) => ({
      subject: q.subject,
      predicate: q.predicate,
      object: q.object,
    }));
  }

  async getAssetState(contextGraphId: string, name: string): Promise<AssetState> {
    const qs = `?contextGraphId=${encodeURIComponent(contextGraphId)}`;
    const { status, body } = await this.req<AssetState>(
      'GET',
      `/api/knowledge-assets/${encodeURIComponent(name)}${qs}`,
    );
    if (status !== 200) throw new Error(`getAssetState(${name}) failed: HTTP ${status}`);
    return {
      memoryLayer: body?.memoryLayer,
      state: body?.state,
      assertionGraph: body?.assertionGraph,
      reservedUal: body?.reservedUal,
    };
  }

  async endorse(contextGraphId: string, name: string): Promise<void> {
    const { status } = await this.req('POST', '/api/endorse', { contextGraphId, name });
    // endorse is best-effort in the MVP; a 404 (route not yet on this node)
    // shouldn't crash the lifecycle.
    if (status !== 200 && status !== 404) {
      throw new Error(`endorse(${name}) failed: HTTP ${status}`);
    }
  }
}
