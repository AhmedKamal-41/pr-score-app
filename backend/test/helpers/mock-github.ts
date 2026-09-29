import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createPublicKey, generateKeyPairSync, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * In-process fake of the GitHub REST endpoints this app uses. It:
 *  - verifies the App JWT (RS256, iss = app id) before issuing installation tokens,
 *  - scopes every token to one installation and 404s repos outside it,
 *  - paginates with Link headers exactly like GitHub (per_page/page),
 *  - supports injected failures, token expiry, and a "crash after create" mode.
 * Only loopback is used; no real GitHub access is possible in tests.
 */

export interface MockFile {
  filename: string;
  status?: string;
  additions: number;
  deletions: number;
  patch?: string | null;
}

export interface MockPr {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  created_at: string;
  updated_at: string;
  author: string;
  head_sha: string;
  head_ref: string;
  base_ref: string;
  files: MockFile[];
  /** Report more files than listed (GitHub's 3000-file cap). */
  changed_files_override?: number;
}

export interface MockComment {
  id: number;
  body: string;
  app_id: number | null;
  user: string;
}

interface MockRepo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  installationId: number;
  prs: Map<number, MockPr>;
  checkRuns: Map<string, { status: string; conclusion: string | null; app_id: number }[]>;
  statuses: Map<string, { state: string; context: string }[]>;
  comments: Map<number, MockComment[]>;
}

interface InjectedFailure {
  method: string;
  path: RegExp;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  remaining: number;
}

export interface RequestLogEntry {
  method: string;
  path: string;
  installationId: number | null;
}

export class MockGitHub {
  readonly appId: number;
  readonly privateKeyPem: string;
  private readonly publicKey: KeyObject;
  private server: Server | null = null;
  url = '';
  readonly repos = new Map<string, MockRepo>();
  readonly requests: RequestLogEntry[] = [];
  readonly tokenRequests = new Map<number, number>();
  private readonly tokens = new Map<string, { installationId: number; expiresAt: number }>();
  private failures: InjectedFailure[] = [];
  private nextCommentId = 5000;
  tokenTtlSeconds = 3600;
  /** Simulate GitHub accepting a comment but the response never arriving. */
  failAfterCreateComment = false;
  /** Hook called before every pulls.get (e.g. to move the head mid-fetch). */
  beforePullGet: ((repo: string, number: number, callIndex: number) => void) | null = null;
  private pullGetCalls = 0;

  constructor(appId = 777) {
    this.appId = appId;
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    this.publicKey = createPublicKey(publicKey.export({ type: 'spki', format: 'pem' }));
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ message: String(err) }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  reset(): void {
    this.repos.clear();
    this.requests.length = 0;
    this.tokenRequests.clear();
    this.tokens.clear();
    this.failures = [];
    this.failAfterCreateComment = false;
    this.beforePullGet = null;
    this.pullGetCalls = 0;
    this.tokenTtlSeconds = 3600;
  }

  addRepo(fullName: string, opts: { id: number; installationId: number; private?: boolean }): MockRepo {
    const [owner, name] = fullName.split('/');
    const repo: MockRepo = {
      id: opts.id,
      owner,
      name,
      private: opts.private ?? true,
      installationId: opts.installationId,
      prs: new Map(),
      checkRuns: new Map(),
      statuses: new Map(),
      comments: new Map(),
    };
    this.repos.set(fullName.toLowerCase(), repo);
    return repo;
  }

  repo(fullName: string): MockRepo {
    const r = this.repos.get(fullName.toLowerCase());
    if (!r) throw new Error(`mock repo ${fullName} not found`);
    return r;
  }

  setPr(fullName: string, pr: MockPr): void {
    this.repo(fullName).prs.set(pr.number, pr);
  }

  setChecks(fullName: string, sha: string, runs: { status: string; conclusion: string | null; app_id?: number }[]): void {
    this.repo(fullName).checkRuns.set(sha, runs.map((r) => ({ app_id: 1, ...r })));
  }

  setStatuses(fullName: string, sha: string, statuses: { state: string; context: string }[]): void {
    this.repo(fullName).statuses.set(sha, statuses);
  }

  comments(fullName: string, number: number): MockComment[] {
    const repo = this.repo(fullName);
    if (!repo.comments.has(number)) repo.comments.set(number, []);
    return repo.comments.get(number)!;
  }

  addUserComment(fullName: string, number: number, body: string): MockComment {
    const c = { id: this.nextCommentId++, body, app_id: null, user: 'some-user' };
    this.comments(fullName, number).push(c);
    return c;
  }

  failNext(method: string, path: RegExp, status: number, opts: { headers?: Record<string, string>; body?: unknown; times?: number } = {}): void {
    this.failures.push({ method, path, status, headers: opts.headers, body: opts.body, remaining: opts.times ?? 1 });
  }

  count(method: string, path: RegExp): number {
    return this.requests.filter((r) => r.method === method && path.test(r.path)).length;
  }

  // ------------------------------------------------------------------ server

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : undefined;
  }

  private verifyJwt(token: string): boolean {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [h, p, s] = parts;
    const ok = verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`), this.publicKey, Buffer.from(s, 'base64url'));
    if (!ok) return false;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as { iss?: unknown; exp?: number };
    return String(payload.iss) === String(this.appId) && typeof payload.exp === 'number' && payload.exp * 1000 > Date.now();
  }

  private paginate<T>(res: ServerResponse, url: URL, items: T[], wrap?: (page: T[]) => unknown) {
    const perPage = Math.min(Number(url.searchParams.get('per_page') ?? 30), 100);
    const page = Math.max(Number(url.searchParams.get('page') ?? 1), 1);
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    const last = Math.max(1, Math.ceil(items.length / perPage));
    if (page < last) {
      const next = new URL(url.toString());
      next.searchParams.set('page', String(page + 1));
      next.searchParams.set('per_page', String(perPage));
      headers.link = `<${this.url}${next.pathname}${next.search}>; rel="next", <${this.url}${next.pathname}?per_page=${perPage}&page=${last}>; rel="last"`;
    }
    this.send(res, 200, wrap ? wrap(slice) : slice, headers);
  }

  private prJson(repo: MockRepo, pr: MockPr) {
    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft ?? false,
      merged_at: pr.merged_at ?? null,
      closed_at: pr.closed_at ?? null,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      user: { login: pr.author },
      head: { sha: pr.head_sha, ref: pr.head_ref },
      base: {
        ref: pr.base_ref,
        repo: {
          id: repo.id,
          name: repo.name,
          full_name: `${repo.owner}/${repo.name}`,
          owner: { login: repo.owner },
          private: repo.private,
          visibility: repo.private ? 'private' : 'public',
        },
      },
      additions: pr.files.reduce((s, f) => s + f.additions, 0),
      deletions: pr.files.reduce((s, f) => s + f.deletions, 0),
      changed_files: pr.changed_files_override ?? pr.files.length,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://mock');
    const method = req.method ?? 'GET';
    const path = url.pathname;
    const auth = req.headers.authorization ?? '';

    // Installation token exchange (authenticated with the App JWT).
    const tokenMatch = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (method === 'POST' && tokenMatch) {
      const installationId = Number(tokenMatch[1]);
      this.requests.push({ method, path, installationId });
      if (!auth.startsWith('bearer ') && !auth.startsWith('Bearer ')) return this.send(res, 401, { message: 'JWT required' });
      if (!this.verifyJwt(auth.slice(7))) return this.send(res, 401, { message: 'A JSON web token could not be decoded' });
      const known = [...this.repos.values()].some((r) => r.installationId === installationId);
      if (!known) return this.send(res, 404, { message: 'Not Found' });
      const n = (this.tokenRequests.get(installationId) ?? 0) + 1;
      this.tokenRequests.set(installationId, n);
      const token = `ghs_mock_${installationId}_${n}_${Math.random().toString(36).slice(2)}`;
      const expiresAt = Date.now() + this.tokenTtlSeconds * 1000;
      this.tokens.set(token, { installationId, expiresAt });
      return this.send(res, 201, {
        token,
        expires_at: new Date(expiresAt).toISOString(),
        permissions: { pull_requests: 'read', checks: 'read', statuses: 'read', issues: 'write' },
        repository_selection: 'selected',
      });
    }

    const tokenInfo = this.tokens.get(auth.replace(/^token\s+/i, '').replace(/^bearer\s+/i, ''));
    const installationId = tokenInfo && tokenInfo.expiresAt > Date.now() ? tokenInfo.installationId : null;
    this.requests.push({ method, path, installationId });

    const failure = this.failures.find((f) => f.remaining > 0 && f.method === method && f.path.test(path));
    if (failure) {
      failure.remaining -= 1;
      return this.send(res, failure.status, failure.body ?? { message: 'injected failure' }, failure.headers);
    }
    if (installationId === null) return this.send(res, 401, { message: 'Bad credentials' });

    const repoMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!repoMatch) return this.send(res, 404, { message: 'Not Found' });
    const repo = this.repos.get(`${repoMatch[1]}/${repoMatch[2]}`.toLowerCase());
    // Installation isolation: a token only sees its own installation's repositories.
    if (!repo || repo.installationId !== installationId) return this.send(res, 404, { message: 'Not Found' });
    const rest = repoMatch[3] ?? '';

    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = rest.match(/^\/pulls\/(\d+)$/))) {
      const number = Number(m[1]);
      this.beforePullGet?.(`${repo.owner}/${repo.name}`, number, this.pullGetCalls++);
      const pr = repo.prs.get(number);
      return pr ? this.send(res, 200, this.prJson(repo, pr)) : this.send(res, 404, { message: 'Not Found' });
    }
    if (method === 'GET' && (m = rest.match(/^\/pulls\/(\d+)\/files$/))) {
      const pr = repo.prs.get(Number(m[1]));
      if (!pr) return this.send(res, 404, { message: 'Not Found' });
      const files = pr.files.slice(0, 3000).map((f) => ({
        filename: f.filename,
        status: f.status ?? 'modified',
        additions: f.additions,
        deletions: f.deletions,
        changes: f.additions + f.deletions,
        ...(f.patch === null ? {} : { patch: f.patch ?? `@@ -1 +1 @@\n+change in ${f.filename}` }),
      }));
      return this.paginate(res, url, files);
    }
    if (method === 'GET' && (m = rest.match(/^\/commits\/([0-9a-f]{40})\/check-runs$/))) {
      const runs = (repo.checkRuns.get(m[1]) ?? []).map((r, i) => ({ id: i + 1, name: `check-${i}`, status: r.status, conclusion: r.conclusion, app: { id: r.app_id } }));
      return this.paginate(res, url, runs, (page) => ({ total_count: runs.length, check_runs: page }));
    }
    if (method === 'GET' && (m = rest.match(/^\/commits\/([0-9a-f]{40})\/status$/))) {
      const statuses = repo.statuses.get(m[1]) ?? [];
      const state = statuses.some((s) => s.state === 'failure' || s.state === 'error') ? 'failure' : statuses.every((s) => s.state === 'success') && statuses.length ? 'success' : 'pending';
      return this.send(res, 200, { sha: m[1], state, total_count: statuses.length, statuses });
    }
    if ((m = rest.match(/^\/issues\/comments\/(\d+)$/))) {
      const id = Number(m[1]);
      const all = [...repo.comments.values()].flat();
      const comment = all.find((c) => c.id === id);
      if (!comment) return this.send(res, 404, { message: 'Not Found' });
      if (method === 'GET') return this.send(res, 200, this.commentJson(comment));
      if (method === 'PATCH') {
        if (comment.app_id !== this.appId) return this.send(res, 403, { message: 'Resource not accessible by integration' });
        const body = (await this.readBody(req)) as { body: string };
        comment.body = body.body;
        return this.send(res, 200, this.commentJson(comment));
      }
    }
    if ((m = rest.match(/^\/issues\/(\d+)\/comments$/))) {
      const number = Number(m[1]);
      if (method === 'GET') return this.paginate(res, url, this.comments(`${repo.owner}/${repo.name}`, number).map((c) => this.commentJson(c)));
      if (method === 'POST') {
        const body = (await this.readBody(req)) as { body: string };
        const comment = { id: this.nextCommentId++, body: body.body, app_id: this.appId, user: 'pr-risk-scorer[bot]' };
        this.comments(`${repo.owner}/${repo.name}`, number).push(comment);
        if (this.failAfterCreateComment) {
          this.failAfterCreateComment = false;
          return this.send(res, 502, { message: 'Bad gateway (comment was created)' });
        }
        return this.send(res, 201, this.commentJson(comment));
      }
    }
    return this.send(res, 404, { message: `Mock route not implemented: ${method} ${path}` });
  }

  private commentJson(c: MockComment) {
    return {
      id: c.id,
      body: c.body,
      user: { login: c.user, type: c.app_id ? 'Bot' : 'User' },
      performed_via_github_app: c.app_id ? { id: c.app_id, slug: 'pr-risk-scorer' } : null,
    };
  }
}

/** Build a realistic GitHub webhook payload for a PR. */
export function pullRequestPayload(
  action: string,
  repo: { id: number; full_name: string; private?: boolean },
  pr: { id: number; number: number; head_sha: string },
  installationId: number,
  extra: Record<string, unknown> = {},
) {
  const [owner, name] = repo.full_name.split('/');
  return {
    action,
    number: pr.number,
    pull_request: { id: pr.id, number: pr.number, head: { sha: pr.head_sha, ref: 'feature' }, base: { ref: 'main' }, title: 'ignored by the app' },
    repository: { id: repo.id, name, full_name: repo.full_name, owner: { login: owner }, private: repo.private ?? true },
    installation: { id: installationId },
    sender: { login: 'someone' },
    ...extra,
  };
}

export function sha(n: number | string): string {
  const hex = Buffer.from(String(n)).toString('hex');
  return (hex + '0'.repeat(40)).slice(0, 40);
}
