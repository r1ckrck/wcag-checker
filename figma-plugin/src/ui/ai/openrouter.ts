// OpenRouter — chat-completions API, OpenAI-compatible shape.
//
// Endpoint:  https://openrouter.ai/api/v1/chat/completions
// Auth:      Authorization: Bearer <key>
// JSON mode: response_format: { type: 'json_object' }
// Image:     content part of type 'image_url' with a data: URL
// Response:  choices[0].message.content (string) → JSON.parse
//
// CORS: fully supported from any browser origin (designed for client-side use).

import {
  classifyFetchError,
  classifyHttpStatus,
  combineSignals,
  ProviderError,
  safeReadText,
  type VisionProvider,
  type VisionRequest,
  type VisionResponse,
} from './provider.ts'
import { stripJsonFences } from './strip-fences.ts'

const URL = 'https://openrouter.ai/api/v1/chat/completions'

export const openRouterProvider: VisionProvider = {
  id: 'openrouter',
  defaultModel: 'anthropic/claude-haiku-4.5',
  async call(req: VisionRequest, opts): Promise<VisionResponse> {
    const { signal, cleanup } = combineSignals(req.timeoutMs, req.signal)
    let response: Response
    try {
      response = await fetch(URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
          // OpenRouter uses HTTP-Referer + X-Title for usage attribution in
          // their dashboard. Figma Desktop's iframe origin isn't a real URL,
          // so we send a stable identifier so the user can find their usage.
          'HTTP-Referer': 'https://figma.com',
          'X-Title': 'Maanak — Accessibility Checker',
        },
        body: JSON.stringify({
          model: opts.model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: req.systemPrompt },
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: `data:image/${req.image.mimeType};base64,${req.image.base64}` },
                },
                { type: 'text', text: req.userText },
              ],
            },
          ],
        }),
        signal,
      })
    } catch (e) {
      cleanup()
      throw classifyFetchError(e)
    }

    if (!response.ok) {
      const text = await safeReadText(response)
      cleanup()
      throw classifyHttpStatus(response.status, text || response.statusText)
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (e) {
      cleanup()
      throw new ProviderError('bad-output', response.status, `non-JSON response: ${String(e)}`)
    } finally {
      cleanup()
    }

    const content = extractContent(payload)
    if (content == null) {
      throw new ProviderError(
        'bad-output',
        response.status,
        `unexpected response shape: ${JSON.stringify(payload).slice(0, 200)}`
      )
    }

    try {
      const parsed = JSON.parse(stripJsonFences(content))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ProviderError('bad-output', response.status, 'model returned non-object JSON')
      }
      return parsed as VisionResponse
    } catch (e) {
      if (e instanceof ProviderError) throw e
      throw new ProviderError('bad-output', response.status, `model returned non-JSON: ${content.slice(0, 200)}`)
    }
  },
}

function extractContent(payload: unknown): string | null {
  if (!isObject(payload)) return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (!isObject(first)) return null
  const message = (first as { message?: unknown }).message
  if (!isObject(message)) return null
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content : null
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
