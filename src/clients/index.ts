import { OpenAIChatSerializer } from './openai-chat.js';
import { OpenAIResponsesSerializer } from './openai-responses.js';
import { AnthropicMessagesSerializer } from './anthropic-messages.js';
import { GeminiSerializer } from './gemini-generatecontent.js';
import type { ClientSerializer, ClientProtocol } from './types.js';

export function createClientSerializer(protocol: ClientProtocol): ClientSerializer {
  switch (protocol) {
    case 'OpenAI-Chat': return new OpenAIChatSerializer();
    case 'OpenAI-Responses': return new OpenAIResponsesSerializer();
    case 'Anthropic-Messages': return new AnthropicMessagesSerializer();
    case 'Gemini-GenerateContent': return new GeminiSerializer();
  }
}

export { OpenAIChatSerializer, OpenAIResponsesSerializer, AnthropicMessagesSerializer, GeminiSerializer };
export type { ClientSerializer, ClientProtocol, ClientSseEvent, StreamState, ResponseMeta, ExpectedRequestShape } from './types.js';
export { SerializerError } from './types.js';
