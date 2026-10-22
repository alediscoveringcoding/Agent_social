import type { NativeProvider } from '../types.ts'
import { blueskyProvider } from './bluesky.ts'
import { devtoProvider } from './devto.ts'
import { telegramProvider } from './telegram.ts'
import { xProvider } from './x.ts'
import { linkedinProvider, linkedinPageProvider } from './linkedin.ts'
import { facebookProvider, instagramProvider } from './meta.ts'
import { youtubeProvider } from './youtube.ts'
import { tiktokProvider } from './tiktok.ts'

const providers: readonly NativeProvider[] = [blueskyProvider, devtoProvider, telegramProvider, xProvider, linkedinProvider, linkedinPageProvider, facebookProvider, instagramProvider, youtubeProvider, tiktokProvider]
export function nativeProvider(platform: string): NativeProvider {
  const provider = providers.find((item) => item.platform === platform)
  if (!provider) throw new Error('NATIVE_PROVIDER_UNAVAILABLE')
  return provider
}
