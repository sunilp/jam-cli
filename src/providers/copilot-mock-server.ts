import * as http from 'node:http';

export type MockScenario = 'tool_calls' | 'text_response';

export interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

export interface MockCopilotServer {
  start(): Promise<number>;
  stop(): Promise<void>;
  getRequests(): RecordedRequest[];
}

const MOCK_MODELS = {
  data: [
    { id: 'copilot-gpt-4o', object: 'model', created: 1699000000, owned_by: 'copilot' },
    { id: 'copilot-claude-3.5-sonnet', object: 'model', created: 1699000000, owned_by: 'copilot' },
  ],
};

function makeToolCallsResponse() {
  return {
    id: 'chatcmpl-toolcall001',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'copilot-gpt-4o',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_abc123',
              type: 'function',
              function: {
                name: 'list_dir',
                arguments: JSON.stringify({ path: '.' }),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: {
      prompt_tokens: 42,
      completion_tokens: 18,
      total_tokens: 60,
    },
  };
}

function makeTextResponse() {
  return {
    id: 'chatcmpl-textresp001',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'copilot-gpt-4o',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello from the mock Copilot server!',
          tool_calls: undefined,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 7,
      total_tokens: 17,
    },
  };
}

/**
 * Creates a lightweight HTTP server that mimics the copilot-lm-server protocol.
 *
 * Endpoints:
 *   GET  /health                → { status: 'ok' }
 *   GET  /v1/models             → model list
 *   POST /v1/chat/completions   → tool call or text response, depending on scenario
 *
 * All incoming POST bodies are recorded and accessible via getRequests().
 */
export function createMockCopilotServer(scenario: MockScenario = 'tool_calls'): MockCopilotServer {
  const requests: RecordedRequest[] = [];

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // Collect body for POST requests
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let parsedBody: unknown = null;
      if (chunks.length > 0) {
        try {
          parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
        } catch {
          parsedBody = Buffer.concat(chunks).toString('utf-8');
        }
      }

      requests.push({ url, method, body: parsedBody });

      res.setHeader('Content-Type', 'application/json');

      if (method === 'GET' && url === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (method === 'GET' && url === '/v1/models') {
        res.writeHead(200);
        res.end(JSON.stringify(MOCK_MODELS));
        return;
      }

      if (method === 'POST' && url === '/v1/chat/completions') {
        const payload = scenario === 'tool_calls' ? makeToolCallsResponse() : makeTextResponse();
        res.writeHead(200);
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: `Not found: ${method} ${url}` }));
    });
  });

  return {
    start(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Unexpected server address'));
            return;
          }
          resolve(address.port);
        });
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    getRequests(): RecordedRequest[] {
      return [...requests];
    },
  };
}
