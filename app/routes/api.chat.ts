import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { generateId, stepCountIs } from 'ai';
import { MAX_RESPONSE_SEGMENTS, MAX_TOKENS, type FileMap } from '~/lib/.server/llm/constants';
import { CONTINUE_PROMPT } from '~/lib/common/prompts/prompts';
import { streamText, type Messages, type StreamingOptions } from '~/lib/.server/llm/stream-text';
import SwitchableStream from '~/lib/.server/llm/switchable-stream';
import type { IProviderSetting } from '~/types/model';
import { createScopedLogger } from '~/utils/logger';
import { getFilePaths, selectContext } from '~/lib/.server/llm/select-context';
import { createSummary } from '~/lib/.server/llm/create-summary';
import { extractPropertiesFromMessage } from '~/lib/.server/llm/utils';
import type { DesignScheme } from '~/types/design-scheme';
import { MCPService } from '~/lib/services/mcpService';
import { StreamRecoveryManager } from '~/lib/.server/llm/stream-recovery';

export async function action(args: ActionFunctionArgs) {
  return chatAction(args);
}

const logger = createScopedLogger('api.chat');

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};

  const items = cookieHeader.split(';').map((cookie) => cookie.trim());

  items.forEach((item) => {
    const [name, ...rest] = item.split('=');

    if (name && rest) {
      const decodedName = decodeURIComponent(name.trim());
      const decodedValue = decodeURIComponent(rest.join('=').trim());
      cookies[decodedName] = decodedValue;
    }
  });

  return cookies;
}

async function chatAction({ context, request }: ActionFunctionArgs) {
  const streamRecovery = new StreamRecoveryManager({
    timeout: 45000,
    maxRetries: 2,
    onTimeout: () => {
      logger.warn('Stream timeout - attempting recovery');
    },
  });

  const { messages, files, promptId, contextOptimization, supabase, chatMode, designScheme, maxLLMSteps } =
    await request.json<{
      messages: Messages;
      files: any;
      promptId?: string;
      contextOptimization: boolean;
      chatMode: 'discuss' | 'build';
      designScheme?: DesignScheme;
      supabase?: {
        isConnected: boolean;
        hasSelectedProject: boolean;
        credentials?: {
          anonKey?: string;
          supabaseUrl?: string;
        };
      };
      maxLLMSteps: number;
    }>();

  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = JSON.parse(parseCookies(cookieHeader || '').apiKeys || '{}');
  const providerSettings: Record<string, IProviderSetting> = JSON.parse(
    parseCookies(cookieHeader || '').providers || '{}',
  );

  const stream = new SwitchableStream();

  const cumulativeUsage = {
    outputTokens: 0,
    inputTokens: 0,
    totalTokens: 0,
  };

  try {
    const mcpService = MCPService.getInstance();
    const totalMessageContent = messages.reduce((acc, message) => {
      // UIMessage has parts, not always content
      const text = (message as any).content || '';
      return acc + text;
    }, '');
    logger.debug(`Total message length: ${totalMessageContent.split(' ').length}, words`);

    const processedMessages = await mcpService.processToolInvocations(messages, null);

    const filePaths = getFilePaths(files || {});
    let filteredFiles: FileMap | undefined = undefined;
    let summary: string | undefined = undefined;
    let messageSliceId = 0;

    if (processedMessages.length > 3) {
      messageSliceId = processedMessages.length - 3;
    }

    if (filePaths.length > 0 && contextOptimization) {
      logger.debug('Generating Chat Summary');

      console.log(`Messages count: ${processedMessages.length}`);

      summary = await createSummary({
        messages: [...processedMessages],
        env: context.cloudflare?.env,
        apiKeys,
        providerSettings,
        promptId,
        contextOptimization,
        onFinish(resp) {
          if (resp.usage) {
            logger.debug('createSummary token usage', JSON.stringify(resp.usage));
            cumulativeUsage.outputTokens +=
              (resp.usage as any).outputTokens || (resp.usage as any).completionTokens || 0;
            cumulativeUsage.inputTokens += (resp.usage as any).inputTokens || (resp.usage as any).promptTokens || 0;
            cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
          }
        },
      });

      logger.debug('Updating Context Buffer');

      console.log(`Messages count: ${processedMessages.length}`);
      filteredFiles = await selectContext({
        messages: [...processedMessages],
        env: context.cloudflare?.env,
        apiKeys,
        files,
        providerSettings,
        promptId,
        contextOptimization,
        summary,
        onFinish(resp) {
          if (resp.usage) {
            logger.debug('selectContext token usage', JSON.stringify(resp.usage));
            cumulativeUsage.outputTokens +=
              (resp.usage as any).outputTokens || (resp.usage as any).completionTokens || 0;
            cumulativeUsage.inputTokens += (resp.usage as any).inputTokens || (resp.usage as any).promptTokens || 0;
            cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
          }
        },
      });

      if (filteredFiles) {
        logger.debug(`files in context : ${JSON.stringify(Object.keys(filteredFiles))}`);
      }
    }

    const maxLLMStepsValue = maxLLMSteps || 5;
    const options: StreamingOptions = {
      supabaseConnection: supabase,
      toolChoice: 'auto' as any,
      tools: mcpService.toolsWithoutExecute,
      stopWhen: stepCountIs(maxLLMStepsValue),
      onFinish: async ({ text: content, finishReason, usage }) => {
        logger.debug('usage', JSON.stringify(usage));

        if (usage) {
          cumulativeUsage.outputTokens += (usage as any).outputTokens || (usage as any).completionTokens || 0;
          cumulativeUsage.inputTokens += (usage as any).inputTokens || (usage as any).promptTokens || 0;
          cumulativeUsage.totalTokens += (usage as any).totalTokens || 0;
        }

        if (finishReason !== 'length') {
          return;
        }

        if (stream.switches >= MAX_RESPONSE_SEGMENTS) {
          throw Error('Cannot continue message: Maximum segments reached');
        }

        const switchesLeft = MAX_RESPONSE_SEGMENTS - stream.switches;

        logger.info(`Reached max token limit (${MAX_TOKENS}): Continuing message (${switchesLeft} switches left)`);

        const lastUserMessage = processedMessages.filter((x) => x.role == 'user').slice(-1)[0];
        const { model, provider } = extractPropertiesFromMessage(lastUserMessage);
        processedMessages.push({ id: generateId(), role: 'assistant', content } as any);
        processedMessages.push({
          id: generateId(),
          role: 'user',
          content: `[Model: ${model}]\n\n[Provider: ${provider}]\n\n${CONTINUE_PROMPT}`,
        } as any);

        await streamText({
          messages: [...processedMessages],
          env: context.cloudflare?.env,
          options,
          apiKeys,
          files,
          providerSettings,
          promptId,
          contextOptimization,
          contextFiles: filteredFiles,
          chatMode,
          designScheme,
          summary,
          messageSliceId,
        });

        /*
         * In ai@6, we use toUIMessageStreamResponse which handles piping
         * The continuation result is handled through the stream
         */
        return;
      },
    };

    streamRecovery.startMonitoring();

    const result = await streamText({
      messages: [...processedMessages],
      env: context.cloudflare?.env,
      options,
      apiKeys,
      files,
      providerSettings,
      promptId,
      contextOptimization,
      contextFiles: filteredFiles,
      chatMode,
      designScheme,
      summary,
      messageSliceId,
    });

    // Monitor the stream for errors
    (async () => {
      for await (const part of result.fullStream) {
        streamRecovery.updateActivity();

        if (part.type === 'error') {
          const error: any = part.error;
          logger.error('Streaming error:', error);
          streamRecovery.stop();

          if (error.message?.includes('Invalid JSON response')) {
            logger.error('Invalid JSON response detected - likely malformed API response');
          } else if (error.message?.includes('token')) {
            logger.error('Token-related error detected - possible token limit exceeded');
          }

          return;
        }
      }
      streamRecovery.stop();
    })();

    // Use toUIMessageStreamResponse() for ai@6 compatible response
    return result.toUIMessageStreamResponse();
  } catch (error: any) {
    logger.error(error);

    const errorResponse = {
      error: true,
      message: error.message || 'An unexpected error occurred',
      statusCode: error.statusCode || 500,
      isRetryable: error.isRetryable !== false,
      provider: error.provider || 'unknown',
    };

    if (error.message?.includes('API key')) {
      return new Response(
        JSON.stringify({
          ...errorResponse,
          message: 'Invalid or missing API key',
          statusCode: 401,
          isRetryable: false,
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
          statusText: 'Unauthorized',
        },
      );
    }

    return new Response(JSON.stringify(errorResponse), {
      status: errorResponse.statusCode,
      headers: { 'Content-Type': 'application/json' },
      statusText: 'Error',
    });
  }
}
