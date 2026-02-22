import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useApp, useInput, Static } from 'ink';
import TextInput from 'ink-text-input';
import type { ProviderAdapter, Message } from '../providers/base.js';
import type { JamConfig } from '../config/schema.js';
import { appendMessage } from '../storage/history.js';

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

      let fullResponse = '';
      let interrupted = false;

      try {
        const stream = provider.streamCompletion({
          messages: conversationRef.current,
          model: profile?.model,
          temperature: profile?.temperature,
          maxTokens: profile?.maxTokens,
          systemPrompt: profile?.systemPrompt,
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
