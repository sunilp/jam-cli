/**
 * E2E test: jam run with mock Copilot proxy.
 *
 * Starts a mock server that simulates the VSCode Copilot LM proxy,
 * spawns `jam run` as a subprocess with JAM_VSCODE_LM_PORT set,
 * and verifies all requested files are created correctly.
 *
 * This tests the full pipeline: auto-detection → proxy backend →
 * tool call round-trip → file creation → completeness.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockCopilotServer } from './copilot-mock-server.js';

const execFileAsync = promisify(execFile);

// Path to the compiled CLI entry point
const CLI_PATH = join(import.meta.dirname, '..', '..', 'dist', 'index.js');

describe('E2E: jam run with mock Copilot proxy', () => {
  const mock = createMockCopilotServer('conversational');
  let port: number;
  let workDir: string;

  beforeAll(async () => {
    port = await mock.start();
    workDir = mkdtempSync(join(tmpdir(), 'jam-e2e-'));
    // Init a git repo (required by jam)
    await execFileAsync('git', ['init'], { cwd: workDir });
  });

  afterAll(async () => {
    await mock.stop();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('creates all requested Spring Boot files via tool calls', async () => {
    const { stdout, stderr } = await execFileAsync(
      'node',
      [
        CLI_PATH,
        'run',
        'Create a Spring Boot 3.3 app with Post record, PostService, PostController, application.properties, and a test.',
        '--yes',
        '--quiet',
      ],
      {
        cwd: workDir,
        timeout: 60_000,
        env: {
          ...process.env,
          JAM_VSCODE_LM_PORT: String(port),
          // Force copilot provider via auto-detection
          NO_COLOR: '1',
        },
      }
    );

    // Verify all 7 files were created
    const expectedFiles = [
      'pom.xml',
      'src/main/java/com/example/demo/DemoApplication.java',
      'src/main/java/com/example/demo/model/Post.java',
      'src/main/java/com/example/demo/service/PostService.java',
      'src/main/java/com/example/demo/controller/PostController.java',
      'src/main/resources/application.properties',
      'src/test/java/com/example/demo/PostControllerTest.java',
    ];

    for (const file of expectedFiles) {
      const fullPath = join(workDir, file);
      expect(existsSync(fullPath), `${file} should exist`).toBe(true);
    }

    // Verify file contents
    const pom = readFileSync(join(workDir, 'pom.xml'), 'utf-8');
    expect(pom).toContain('spring-boot-starter-web');
    expect(pom).toContain('3.3.0');
    expect(pom).toContain('<java.version>21</java.version>');

    const post = readFileSync(join(workDir, 'src/main/java/com/example/demo/model/Post.java'), 'utf-8');
    expect(post).toContain('record Post');
    expect(post).toContain('userId');

    const service = readFileSync(join(workDir, 'src/main/java/com/example/demo/service/PostService.java'), 'utf-8');
    expect(service).toContain('RestClient');
    expect(service).toContain('getAllPosts');
    expect(service).toContain('getPostById');

    const controller = readFileSync(join(workDir, 'src/main/java/com/example/demo/controller/PostController.java'), 'utf-8');
    expect(controller).toContain('@RestController');
    expect(controller).toContain('/api/posts');
    expect(controller).toContain('@GetMapping');

    const props = readFileSync(join(workDir, 'src/main/resources/application.properties'), 'utf-8');
    expect(props).toContain('jsonplaceholder.typicode.com');

    const test = readFileSync(join(workDir, 'src/test/java/com/example/demo/PostControllerTest.java'), 'utf-8');
    expect(test).toContain('@SpringBootTest');
    expect(test).toContain('MockMvc');
  }, 60_000);

  it('mock server received tool schemas in requests', () => {
    const requests = mock.getRequests();
    const completionRequests = requests.filter(r => r.url === '/v1/chat/completions');

    // Should have multiple rounds of conversation
    expect(completionRequests.length).toBeGreaterThanOrEqual(2);

    // First completion request should contain tools
    const firstBody = completionRequests[0]!.body as Record<string, unknown>;
    expect(firstBody.tools).toBeDefined();
    expect(Array.isArray(firstBody.tools)).toBe(true);
  });

  it('auto-detected copilot provider from JAM_VSCODE_LM_PORT', () => {
    const requests = mock.getRequests();
    // Health check proves the proxy was used
    const healthReqs = requests.filter(r => r.url === '/health');
    expect(healthReqs.length).toBeGreaterThanOrEqual(1);
  });
});
