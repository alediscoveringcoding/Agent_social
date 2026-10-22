import 'server-only'
import type { OAuth2Config } from './oauth.ts'
import { OAUTH_CONNECTIONS } from './capabilities.ts'

export const OAUTH_PLATFORMS = OAUTH_CONNECTIONS.map(item => item.value)
export type OAuthPlatform = typeof OAUTH_PLATFORMS[number]

function required(name: string, env: Readonly<Record<string, string | undefined>>): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`NATIVE_SETUP_REQUIRED:${name}`)
  return value
}
export function callbackOrigin(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const url = new URL(env.PUBLIC_SITE_BASE_URL || env.SITE_BASE_URL || 'http://localhost:3000')
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('NATIVE_SITE_ORIGIN_INVALID')
  return url.origin
}
export function oauthConfig(platform: OAuthPlatform, env: Readonly<Record<string, string | undefined>> = process.env): OAuth2Config {
  const redirectUri = `${callbackOrigin(env)}/api/native/callback`
  const base = { redirectUri, pkce: false }
  switch (platform) {
    case 'x': return { ...base, authorizeUrl: 'https://x.com/i/oauth2/authorize', tokenUrl: 'https://api.x.com/2/oauth2/token',
      clientId: required('X_CLIENT_ID', env), clientSecret: required('X_CLIENT_SECRET', env), tokenAuthentication: 'basic',
      scopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'], pkce: true }
    case 'facebook': {
      const version = required('META_GRAPH_VERSION', env)
      if (!/^v\d{2}\.\d+$/.test(version)) throw new Error('NATIVE_META_VERSION_INVALID')
      return { ...base, authorizeUrl: `https://www.facebook.com/${version}/dialog/oauth`, tokenUrl: `https://graph.facebook.com/${version}/oauth/access_token`,
        clientId: required('FACEBOOK_CLIENT_ID', env), clientSecret: required('FACEBOOK_CLIENT_SECRET', env), scopeSeparator: ',',
        scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'], authorizeParameters: { auth_type: 'rerequest' } }
    }
    case 'instagram': return { ...base, authorizeUrl: 'https://www.instagram.com/oauth/authorize', tokenUrl: 'https://api.instagram.com/oauth/access_token',
      clientId: required('INSTAGRAM_CLIENT_ID', env), clientSecret: required('INSTAGRAM_CLIENT_SECRET', env), scopeSeparator: ',',
      scopes: ['instagram_business_basic', 'instagram_business_content_publish'], authorizeParameters: { enable_fb_login: '0', force_authentication: '1' } }
    case 'linkedin': case 'linkedin-page': return { ...base, authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
      clientId: required('LINKEDIN_CLIENT_ID', env), clientSecret: required('LINKEDIN_CLIENT_SECRET', env),
      scopes: platform === 'linkedin' ? ['openid', 'profile', 'w_member_social'] : ['openid', 'profile', 'rw_organization_admin', 'w_organization_social'] }
    case 'youtube': return { ...base, authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: required('GOOGLE_CLIENT_ID', env), clientSecret: required('GOOGLE_CLIENT_SECRET', env), pkce: true,
      scopes: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'], authorizeParameters: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' } }
    case 'tiktok': return { ...base, authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/', tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
      clientId: required('TIKTOK_CLIENT_KEY', env), clientSecret: required('TIKTOK_CLIENT_SECRET', env), clientIdParameter: 'client_key', scopeSeparator: ',',
      scopes: ['user.info.basic', 'video.publish', 'video.list'] }
  }
}
