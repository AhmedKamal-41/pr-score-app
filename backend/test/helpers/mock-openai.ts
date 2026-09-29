import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockAiResponder = (body: { model: string; messages: { role: string; content: string }[] }) => {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
};

export const VALID_AI_OUTPUT = {
  summary: 'Mocked analysis: authentication changes without tests need careful review.',
  review_focus: ['Session handling changes', 'Token validation paths', 'Error handling for missing credentials'],
  test_suggestions: ['Expired sessions are rejected', 'Invalid tokens return 401', 'Logout revokes the session'],
  rollback_risk: 'MED',
  confidence: 0.65,
  warnings: ['Mocked response for automated tests'],
};

export function completion(content: string) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** Local stand-in for the OpenAI Chat Completions endpoint (no paid calls). */
export class MockOpenAI {
  private server: Server | null = null;
  url = '';
  calls: { model: string; messages: { role: string; content: string }[] }[] = [];
  responder: MockAiResponder = () => ({ status: 200, body: completion(JSON.stringify(VALID_AI_OUTPUT)) });

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      this.calls.push(body);
      const r = this.responder(body);
      if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
      if (res.destroyed) return;
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.body));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/v1`;
    return this.url;
  }

  reset(): void {
    this.calls = [];
    this.responder = () => ({ status: 200, body: completion(JSON.stringify(VALID_AI_OUTPUT)) });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
