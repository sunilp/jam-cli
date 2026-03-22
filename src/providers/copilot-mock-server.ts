import * as http from 'node:http';

export type MockScenario = 'tool_calls' | 'text_response' | 'conversational';

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
 * For 'conversational' scenario: respond based on round number.
 * Simulates a multi-turn agentic loop where the model calls tools
 * to create files, then returns a final text summary.
 */
function makeConversationalResponse(round: number, body: Record<string, unknown>): { response: object; advance: boolean } {
  // Check if tools are available in the request
  const tools = body.tools as Array<{ type: string; function: { name: string } }> | undefined;
  const hasWriteFile = tools?.some(t => t.function.name === 'write_file');

  // Sequence of files to create
  const fileSteps = [
    { name: 'write_file', args: { path: 'pom.xml', content: POM_XML, mode: 'overwrite' } },
    { name: 'write_file', args: { path: 'src/main/java/com/example/demo/DemoApplication.java', content: DEMO_APP, mode: 'overwrite' } },
    { name: 'write_file', args: { path: 'src/main/java/com/example/demo/model/Post.java', content: POST_RECORD, mode: 'overwrite' } },
    { name: 'write_file', args: { path: 'src/main/java/com/example/demo/service/PostService.java', content: POST_SERVICE, mode: 'overwrite' } },
    { name: 'write_file', args: { path: 'src/main/java/com/example/demo/controller/PostController.java', content: POST_CONTROLLER, mode: 'overwrite' } },
    { name: 'write_file', args: { path: 'src/main/resources/application.properties', content: APP_PROPS, mode: 'overwrite' } },
    { name: 'write_file', args: { path: 'src/test/java/com/example/demo/PostControllerTest.java', content: POST_TEST, mode: 'overwrite' } },
  ];

  // If write_file isn't available, or we've created all files, return text (don't advance round)
  if (!hasWriteFile || round >= fileSteps.length) {
    return {
      advance: false,
      response: {
        id: `chatcmpl-final-${round}`,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'All files created successfully. The Spring Boot application is ready.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      },
    };
  }

  const step = fileSteps[round]!;
  return {
    advance: true,
    response: {
      id: `chatcmpl-step-${round}`,
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `call_step_${round}`,
            type: 'function',
            function: { name: step.name, arguments: JSON.stringify(step.args) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    },
  };
}

// ── Template file contents for the conversational mock ────────────────────────

const POM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.3.0</version>
        <relativePath/>
    </parent>
    <groupId>com.example</groupId>
    <artifactId>demo</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <properties><java.version>21</java.version></properties>
    <dependencies>
        <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
        <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId><scope>test</scope></dependency>
    </dependencies>
    <build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build>
</project>`;

const DEMO_APP = `package com.example.demo;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
@SpringBootApplication
public class DemoApplication {
    public static void main(String[] args) { SpringApplication.run(DemoApplication.class, args); }
}`;

const POST_RECORD = `package com.example.demo.model;
public record Post(Long id, Long userId, String title, String body) {}`;

const POST_SERVICE = `package com.example.demo.service;
import com.example.demo.model.Post;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;
import java.util.List;
@Service
public class PostService {
    private final RestClient restClient;
    public PostService(@Value("\${jsonplaceholder.base-url}") String baseUrl) {
        this.restClient = RestClient.builder().baseUrl(baseUrl).build();
    }
    public List<Post> getAllPosts() {
        return restClient.get().uri("/posts").retrieve().body(new ParameterizedTypeReference<>() {});
    }
    public Post getPostById(Long id) {
        return restClient.get().uri("/posts/{id}", id).retrieve().body(Post.class);
    }
}`;

const POST_CONTROLLER = `package com.example.demo.controller;
import com.example.demo.model.Post;
import com.example.demo.service.PostService;
import org.springframework.web.bind.annotation.*;
import java.util.List;
@RestController
@RequestMapping("/api/posts")
public class PostController {
    private final PostService postService;
    public PostController(PostService postService) { this.postService = postService; }
    @GetMapping
    public List<Post> getAllPosts() { return postService.getAllPosts(); }
    @GetMapping("/{id}")
    public Post getPostById(@PathVariable Long id) { return postService.getPostById(id); }
}`;

const APP_PROPS = `jsonplaceholder.base-url=https://jsonplaceholder.typicode.com
server.port=8080`;

const POST_TEST = `package com.example.demo;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
@SpringBootTest
@AutoConfigureMockMvc
class PostControllerTest {
    @Autowired private MockMvc mockMvc;
    @Test void getAllPosts() throws Exception {
        mockMvc.perform(get("/api/posts")).andExpect(status().isOk()).andExpect(jsonPath("$").isArray());
    }
    @Test void getPostById() throws Exception {
        mockMvc.perform(get("/api/posts/1")).andExpect(status().isOk()).andExpect(jsonPath("$.id").value(1));
    }
}`;

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
  let completionRound = 0;

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
        let payload: object;
        if (scenario === 'conversational') {
          const result = makeConversationalResponse(completionRound, (parsedBody ?? {}) as Record<string, unknown>);
          payload = result.response;
          if (result.advance) completionRound++;
        } else {
          payload = scenario === 'tool_calls' ? makeToolCallsResponse() : makeTextResponse();
        }
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
