import {
  fetchAuthorizedWebUiBlob,
  fetchAuthorizedWebUiResource,
  guardedWebUiEventSource,
} from '../services/webui-auth-transport';
import { ChatRuntimeApiClient } from './api-client';
import type { ChatRuntimeTransport } from './api-types';

export const browserChatRuntimeTransport: ChatRuntimeTransport = {
  fetch: fetchAuthorizedWebUiResource,
  fetchBlob: fetchAuthorizedWebUiBlob,
  openEvents: (path) => guardedWebUiEventSource(path),
};

export function createBrowserChatRuntimeApiClient(): ChatRuntimeApiClient {
  return new ChatRuntimeApiClient(browserChatRuntimeTransport);
}
