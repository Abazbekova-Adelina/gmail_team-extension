import { createAssistantHandler } from './handler.js';

// The Gemini key is read only inside the Edge Function, never in the extension.
Deno.serve(createAssistantHandler({ env: (name: string) => Deno.env.get(name) }));
