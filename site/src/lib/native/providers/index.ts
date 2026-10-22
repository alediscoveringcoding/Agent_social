import type { NativeProvider } from '../types.ts'
import { blueskyProvider } from './bluesky.ts'
import { devtoProvider } from './devto.ts'
import { telegramProvider } from './telegram.ts'
import { xProvider } from './x.ts'
import { linkedinProvider, linkedinPageProvider } from './linkedin.ts'
import { facebookProvider, instagramProvider } from './meta.ts'
import { youtubeProvider } from './youtube.ts'
import { tiktokProvider } from './tiktok.ts'
import { mediumProvider } from './medium.ts'
import { hashnodeProvider } from './hashnode.ts'
import { slackProvider } from './slack.ts'
import { githubProvider } from './github.ts'
import { listmonkProvider } from './listmonk.ts'
import { stackexchangeProvider } from './stackexchange.ts'
import { farcasterProvider } from './farcaster.ts'
import { lemmyProvider } from './lemmy.ts'

const providers: readonly NativeProvider[] = [blueskyProvider, devtoProvider, telegramProvider, xProvider, linkedinProvider, linkedinPageProvider, facebookProvider, instagramProvider, youtubeProvider, tiktokProvider, mediumProvider, hashnodeProvider, slackProvider, githubProvider, listmonkProvider, stackexchangeProvider, farcasterProvider, lemmyProvider]
export const REGISTERED_NATIVE_PLATFORMS = providers.map(provider => provider.platform)
export function nativeProvider(platform: string): NativeProvider {
  const provider = providers.find((item) => item.platform === platform)
  if (!provider) throw new Error('NATIVE_PROVIDER_UNAVAILABLE')
  return provider
}
