import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useApp, useInput, Static } from 'ink';
import TextInput from 'ink-text-input';
import type { ProviderAdapter, Message } from '../providers/base.js';
import type { JamConfig } from '../config/schema.js';
import { appendMessage } from '../storage/history.js';
import { READ_ONLY_TOOL_SCHEMAS, executeReadOnlyTool } from '../tools/context-tools.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import {
  ToolCallTracker,
  loadProjectContext,
  buildSystemPrompt,
  enrichUserPrompt,
  generateSearchPlan,
  buildSynthesisReminder,
  buildCorrectionMessage,
} from '../utils/agent.js';
import { WorkingMemory } from '../utils/memory.js';
import { ToolResultCache } from '../utils/cache.js';
import { criticEvaluate, buildCriticCorrection } from '../utils/critic.js';
import { searchPastSessions, formatPastExchanges } from '../utils/past-sessions.js';
import { getOrBuildIndex, searchSymbols, formatSymbolResults } from '../utils/index-builder.js';
import { updateContextWithUsage } from '../utils/context.js';

export interface ChatOptions {
  provider: ProviderAdapter;
  config: JamConfig;
  sessionId: string;
  initialMessages: Message[];
}

interface DisplayMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface ChatAppProps {
  provider: ProviderAdapter;
  config: JamConfig;
  sessionId: string;
  initialMessages: Message[];
}

function formatRole(role: string): string {
  switch (role) {
    case 'user':
      return 'You';
    case 'assistant':
      return 'Jam';
    case 'system':
      return 'System';
    default:
      return role;
  }
}

function MessageItem({ message }: { message: DisplayMessage }): React.ReactElement {
  const roleColor =
    message.role === 'user' ? 'blue' : message.role === 'assistant' ? 'green' : 'gray';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={roleColor} bold>
        {formatRole(message.role)}
      </Text>
      <Text>{message.content}</Text>
    </Box>
  );
}

function ChatApp({
  provider,
  config,
  sessionId,
  initialMessages,
}: ChatAppProps): React.ReactElement {
  const { exit } = useApp();

  // Messages that have been fully committed (shown via Static)
  const [committedMessages, setCommittedMessages] = useState<DisplayMessage[]>(() =>
    initialMessages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: new Date().toISOString(),
      }))
  );

  // Current in-progress assistant streaming text
  const [streamingText, setStreamingText] = useState<string>('');

  // Whether we are currently streaming
  const [isStreaming, setIsStreaming] = useState(false);

  // Whether we are waiting for the first chunk (show spinner)
  const [isThinking, setIsThinking] = useState(false);

  // Error message to display
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // User's current input
  const [inputValue, setInputValue] = useState('');

  // Whether input is disabled (during streaming)
  const [inputDisabled, setInputDisabled] = useState(false);

  // Abort controller ref for cancelling generation
  const abortRef = useRef<AbortController | null>(null);

  // Track ctrl-c timing for double-press exit
  const lastCtrlCRef = useRef<number>(0);

  // Conversation history for the provider (includes all roles)
  const conversationRef = useRef<Message[]>(initialMessages);

  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') {
      const now = Date.now();

      if (isStreaming) {
        // First Ctrl-C during streaming: abort current generation
        if (abortRef.current) {
          abortRef.current.abort();
        }
        return;
      }

      // Double Ctrl-C within 1 second: exit
      if (now - lastCtrlCRef.current < 1000) {
        exit();
        return;
      }

      lastCtrlCRef.current = now;
    }
  });

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || inputDisabled) return;

      setInputValue('');
      setErrorMessage(null);

      const userMessage: Message = { role: 'user', content: trimmed };
      const userDisplay: DisplayMessage = {
        role: 'user',
        content: trimmed,
        timestamp: new Date().toISOString(),
      };

      // Persist user message
      try {
        await appendMessage(sessionId, userMessage);
      } catch {
        // Non-fatal; continue
      }

      // Add to committed messages display
      setCommittedMessages((prev) => [...prev, userDisplay]);

      // Update conversation history
      conversationRef.current = [...conversationRef.current, userMessage];

      // Start streaming
      setIsThinking(true);
      setIsStreaming(true);
      setInputDisabled(true);

      const profile = config.profiles[config.defaultProfile];
      const abortController = new AbortController();
      abortRef.current = abortController;

      // ── Build system prompt (used for BOTH tool gathering AND streaming) ──
      let agentSystemPrompt: string | undefined;

      // ── Agentic tool-gathering phase ─────────────────────────────────────
      // Run read-only tool rounds to gather context before giving final answer.
      if (provider.chatWithTools && !abortController.signal.aborted) {
        try {
          const workspaceRoot = await getWorkspaceRoot();
          const { jamContext, workspaceCtx } = await loadProjectContext(workspaceRoot);
          let toolMessages = [...conversationRef.current];
          const tracker = new ToolCallTracker();
          const memory = new WorkingMemory(provider, profile?.model, undefined);
          const cache = new ToolResultCache();

          agentSystemPrompt =
            profile?.systemPrompt ??
            buildSystemPrompt(jamContext, workspaceCtx);

          memory['systemPrompt'] = agentSystemPrompt;

          // ── Symbol index + past sessions for richer planning ──────────
          let symbolHint = '';
          try {
            const index = await getOrBuildIndex(workspaceRoot);
            const symbols = searchSymbols(index, trimmed, 10);
            symbolHint = formatSymbolResults(symbols);
          } catch { /* non-fatal */ }

          let pastContext = '';
          try {
            const pastExchanges = await searchPastSessions(trimmed, workspaceRoot, 2);
            pastContext = formatPastExchanges(pastExchanges);
          } catch { /* non-fatal */ }

          // ── Planning phase: reason about what to search for ──────────
          setStreamingText('🔍 Planning search strategy…');
          const projectCtxForPlan = [jamContext ?? workspaceCtx, symbolHint, pastContext].filter(Boolean).join('\n\n');

          // Get the user's original question (last user message, before enrichment)
          const originalQuestion = trimmed;

          const searchPlan = await generateSearchPlan(
            provider,
            originalQuestion,
            projectCtxForPlan,
            { model: profile?.model, temperature: profile?.temperature, maxTokens: profile?.maxTokens },
          );

          // Enrich the last user message with the search plan
          const lastMsg = toolMessages[toolMessages.length - 1];
          if (lastMsg && lastMsg.role === 'user') {
            toolMessages[toolMessages.length - 1] = {
              ...lastMsg,
              content: enrichUserPrompt(lastMsg.content, searchPlan),
            };
          }

          let synthesisInjected = false;
          const MAX_TOOL_ROUNDS = 15;
          for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            if (abortController.signal.aborted) break;

            // Context window management: compact if approaching limit
            if (memory.shouldCompact(toolMessages)) {
              setStreamingText('⟳ Compacting context…');
              toolMessages = await memory.compact(toolMessages);
            }

            const response = await provider.chatWithTools(toolMessages, READ_ONLY_TOOL_SCHEMAS, {
              model: profile?.model,
              temperature: profile?.temperature,
              maxTokens: profile?.maxTokens,
              systemPrompt: agentSystemPrompt,
            });

            if (!response.toolCalls?.length) {
              const finalText = response.content ?? '';

              // Synthesis grounding with critic evaluation
              if (tracker.totalCalls > 0 && !synthesisInjected && round < MAX_TOOL_ROUNDS - 2) {
                synthesisInjected = true;

                // Critic evaluation of current answer
                if (finalText.trim().length > 0) {
                  setStreamingText('⟳ Evaluating answer quality…');
                  const verdict = await criticEvaluate(provider, originalQuestion, finalText, { model: profile?.model });
                  if (verdict.pass) {
                    conversationRef.current = toolMessages;
                    // Auto-update JAM.md
                    const log = memory.getAccessLog();
                    updateContextWithUsage(workspaceRoot, log.readFiles, log.searchQueries).catch(() => {});
                    break;
                  }
                  // Critic rejected — use its feedback
                  setStreamingText(`⟳ Critic: ${verdict.reason}`);
                  toolMessages.push({ role: 'assistant', content: finalText });
                  toolMessages.push({ role: 'user', content: buildCriticCorrection(verdict, originalQuestion) });
                  continue;
                }

                setStreamingText('⟳ Grounding answer to your question…');
                toolMessages.push({ role: 'assistant', content: finalText });
                toolMessages.push({ role: 'user', content: buildSynthesisReminder(originalQuestion) });
                continue;
              }

              // Final critic check
              if (tracker.totalCalls > 0 && finalText.trim().length > 30 && round < MAX_TOOL_ROUNDS - 2) {
                const verdict = await criticEvaluate(provider, originalQuestion, finalText, { model: profile?.model });
                if (!verdict.pass) {
                  setStreamingText(`⟳ Critic: ${verdict.reason}`);
                  toolMessages.push({ role: 'assistant', content: finalText });
                  toolMessages.push({ role: 'user', content: buildCriticCorrection(verdict, originalQuestion) });
                  continue;
                }
              }

              // Model has enough context — let streaming use the enriched history
              conversationRef.current = toolMessages;
              const log = memory.getAccessLog();
              updateContextWithUsage(workspaceRoot, log.readFiles, log.searchQueries).catch(() => {});
              break;
            }

            toolMessages.push({ role: 'assistant', content: response.content ?? '' });

            for (const tc of response.toolCalls) {
              if (abortController.signal.aborted) break;

              // Duplicate detection
              if (tracker.isDuplicate(tc.name, tc.arguments)) {
                setStreamingText(`✕ skipped duplicate: ${tc.name}`);
                toolMessages.push({
                  role: 'user',
                  content: `[Tool result: ${tc.name}]\nYou already made this exact call. Try a DIFFERENT query or tool.`,
                });
                tracker.record(tc.name, tc.arguments, true);
                continue;
              }

              // Check cache
              const cached = cache.get(tc.name, tc.arguments);
              if (cached !== null) {
                setStreamingText(`⚙ ${tc.name} (cached)`);
                const capped = memory.processToolResult(tc.name, tc.arguments, cached);
                toolMessages.push({ role: 'user', content: `[Tool result: ${tc.name}]\n${capped}` });
                tracker.record(tc.name, tc.arguments, false);
                continue;
              }

              setStreamingText(`⚙ ${tc.name}(${Object.entries(tc.arguments).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`);
              let toolOutput: string;
              let wasError = false;
              try {
                toolOutput = await executeReadOnlyTool(tc.name, tc.arguments, workspaceRoot);
              } catch (err) {
                toolOutput = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
                wasError = true;
              }

              if (!wasError) cache.set(tc.name, tc.arguments, toolOutput);
              const cappedOutput = memory.processToolResult(tc.name, tc.arguments, toolOutput);

              tracker.record(tc.name, tc.arguments, wasError);
              toolMessages.push({ role: 'user', content: `[Tool result: ${tc.name}]\n${cappedOutput}` });
            }

            // Scratchpad checkpoint
            if (memory.shouldScratchpad(round)) {
              setStreamingText('📝 Working memory checkpoint…');
              toolMessages.push(memory.scratchpadPrompt());
            }

            // Inject correction hints if stuck
            const hint = tracker.getCorrectionHint();
            if (hint) {
              setStreamingText('⚠ Adjusting search strategy…');
              toolMessages.push({ role: 'user', content: hint });
            }

            conversationRef.current = toolMessages;
          }
        } catch {
          // Tool loop error is non-fatal; proceed with streaming
        }
        setStreamingText('');
      }

      // Use the same system prompt for streaming as the tool-gathering phase
      const effectiveSystemPrompt = agentSystemPrompt ?? profile?.systemPrompt;
      let fullResponse = '';
      let interrupted = false;

      try {
        const stream = provider.streamCompletion({
          messages: conversationRef.current,
          model: profile?.model,
          temperature: profile?.temperature,
          maxTokens: profile?.maxTokens,
          systemPrompt: effectiveSystemPrompt,
        });

        for await (const chunk of stream) {
          if (abortController.signal.aborted) {
            interrupted = true;
            break;
          }

          if (!chunk.done) {
            fullResponse += chunk.delta;
            setIsThinking(false);
            setStreamingText(fullResponse);
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          const message = err instanceof Error ? err.message : String(err);
          setErrorMessage(`Error: ${message}`);
        } else {
          interrupted = true;
        }
      }

      // Finalize the streamed message
      const finalContent = interrupted
        ? fullResponse + (fullResponse ? '\n[Generation interrupted]' : '[Generation interrupted]')
        : fullResponse;

      setStreamingText('');
      setIsThinking(false);
      setIsStreaming(false);
      setInputDisabled(false);
      abortRef.current = null;

      if (finalContent) {
        const assistantMessage: Message = { role: 'assistant', content: finalContent };
        const assistantDisplay: DisplayMessage = {
          role: 'assistant',
          content: finalContent,
          timestamp: new Date().toISOString(),
        };

        // Persist assistant message
        try {
          await appendMessage(sessionId, assistantMessage);
        } catch {
          // Non-fatal; continue
        }

        conversationRef.current = [...conversationRef.current, assistantMessage];
        setCommittedMessages((prev) => [...prev, assistantDisplay]);
      }
    },
    [inputDisabled, sessionId, config, provider]
  );

  // Spinner frames for "Thinking..."
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  useEffect(() => {
    if (!isThinking) return;
    const timer = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % spinnerFrames.length);
    }, 80);
    return () => clearInterval(timer);
  }, [isThinking, spinnerFrames.length]);

  return (
    <Box flexDirection="column">
      {/* Committed messages rendered statically (won't re-render) */}
      <Static items={committedMessages}>
        {(message, index) => <MessageItem key={index} message={message} />}
      </Static>

      {/* Streaming response in progress */}
      {isThinking && (
        <Box marginBottom={1}>
          <Text color="yellow">
            {spinnerFrames[spinnerFrame] ?? '⠋'} Thinking...
          </Text>
        </Box>
      )}

      {streamingText !== '' && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="green" bold>
            Jam
          </Text>
          <Text>{streamingText}</Text>
        </Box>
      )}

      {/* Error display */}
      {errorMessage !== null && (
        <Box marginBottom={1}>
          <Text color="red">{errorMessage}</Text>
        </Box>
      )}

      {/* Input area */}
      <Box>
        <Text color="blue" bold>
          {'> '}
        </Text>
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={(val) => { void handleSubmit(val); }}
          placeholder={inputDisabled ? 'Generating...' : 'Ask something... (Ctrl-C twice to exit)'}
          focus={!inputDisabled}
        />
      </Box>
    </Box>
  );
}

export async function startChat(options: ChatOptions): Promise<void> {
  const { waitUntilExit } = render(
    <ChatApp
      provider={options.provider}
      config={options.config}
      sessionId={options.sessionId}
      initialMessages={options.initialMessages}
    />
  );

  await waitUntilExit();
}
