import { nativeRequest, NativeProviderError } from '../http.ts'
import { requireSecret, type NativeContext, type NativeProvider } from '../types.ts'
import { mediaBlob, metricSnapshot, publishedId, requestedDestination, requiredString } from './shared.ts'

interface TelegramResult<T> { ok: boolean; result: T; error_code?: number; parameters?: { retry_after?: number } }
interface Chat { id: number; type: string; title?: string; username?: string; first_name?: string }
interface Message { message_id: number; chat: Chat }

async function telegram<T>(ctx: NativeContext, token: string, method: string, body?: Record<string, unknown> | FormData, write = false): Promise<T> {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('NATIVE_TELEGRAM_TOKEN_INVALID')
  const { data } = await nativeRequest<TelegramResult<T>>(ctx, `https://api.telegram.org/bot${token}/${method}`, { method: body ? 'POST' : 'GET', body, write, timeoutMs: 120_000 })
  if (!data?.ok) {
    const status = data?.error_code ?? 502
    throw new NativeProviderError(status === 429 ? 'RATE_LIMITED' : status === 401 ? 'AUTH_EXPIRED' : status === 403 ? 'PERMISSION_DENIED' : status >= 500 && write ? 'UNKNOWN_RESULT' : 'VALIDATION_REJECTED', status, status >= 500 && write, data?.parameters?.retry_after)
  }
  return data.result
}

function messageUrl(message: Message): string | undefined {
  if (message.chat.username) return `https://t.me/${encodeURIComponent(message.chat.username)}/${message.message_id}`
  const id = String(message.chat.id)
  return id.startsWith('-100') ? `https://t.me/c/${id.slice(4)}/${message.message_id}` : undefined
}

/** Official API: https://core.telegram.org/bots/api */
export const telegramProvider: NativeProvider = {
  platform: 'telegram',
  async connect(ctx, input) {
    const token = requireSecret(input.credentials, 'botToken')
    const destination = requestedDestination(input)
    if (!/^(?:-?\d+|@[A-Za-z0-9_]{5,})$/.test(destination)) throw new Error('NATIVE_TELEGRAM_CHAT_REQUIRED')
    const bot = await telegram<{ id: number }>(ctx, token, 'getMe')
    const chat = await telegram<Chat>(ctx, token, 'getChat', { chat_id: destination })
    const remoteId = requiredString(chat.id)
    if (chat.type === 'channel' || chat.type === 'supergroup' || chat.type === 'group') {
      const membership = await telegram<{ status: string; can_post_messages?: boolean }>(ctx, token, 'getChatMember', { chat_id: remoteId, user_id: bot.id })
      if (['left', 'kicked', 'restricted'].includes(membership.status) || (chat.type === 'channel' && membership.status !== 'creator' && membership.can_post_messages !== true)) throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    }
    return [{ platform: 'telegram', remoteId, displayName: chat.title || chat.first_name || chat.username || remoteId, profileUrl: chat.username ? `https://t.me/${encodeURIComponent(chat.username)}` : undefined, metadata: { botId: bot.id, chatType: chat.type, username: chat.username ?? '' }, credentials: { secrets: { botToken: token } } }]
  },
  async publish(ctx, input) {
    const token = requireSecret(input.account, 'botToken')
    const chatId = input.account.remoteId
    let message: Message
    if (!input.media.length) {
      message = await telegram<Message>(ctx, token, 'sendMessage', { chat_id: chatId, text: input.text }, true)
    } else if (input.media.length === 1) {
      const media = input.media[0]
      const video = media.mime.startsWith('video/')
      const form = new FormData()
      form.set('chat_id', chatId)
      form.set('caption', input.text)
      form.set(video ? 'video' : 'photo', await mediaBlob(ctx, media), media.filename)
      message = await telegram<Message>(ctx, token, video ? 'sendVideo' : 'sendPhoto', form, true)
    } else {
      if (input.media.length > 10) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
      const form = new FormData()
      form.set('chat_id', chatId)
      const media: Array<Record<string, unknown>> = []
      for (const [index, item] of input.media.entries()) {
        const key = `asset${index}`
        form.set(key, await mediaBlob(ctx, item), item.filename)
        media.push({ type: item.mime.startsWith('video/') ? 'video' : 'photo', media: `attach://${key}`, ...(index === 0 ? { caption: input.text } : {}) })
      }
      form.set('media', JSON.stringify(media))
      const messages = await telegram<Message[]>(ctx, token, 'sendMediaGroup', form, true)
      message = messages?.[0]
    }
    return { remoteId: publishedId(message?.message_id), remoteUrl: message?.chat ? messageUrl(message) : undefined, status: 'published' }
  },
  async metrics(ctx, account) {
    const count = await telegram<number>(ctx, requireSecret(account, 'botToken'), 'getChatMemberCount', { chat_id: account.remoteId })
    return metricSnapshot(ctx.now(), { followers: count }, ['followers', 'views', 'likes', 'comments', 'shares'])
  },
}
