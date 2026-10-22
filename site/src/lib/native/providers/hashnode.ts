import { bearer, nativeRequest, NativeProviderError } from '../http.ts'
import { requireSecret, stringSetting, type NativeProvider } from '../types.ts'
import { instanceUrl, mediaBlob, publicHttpsUrl, publishedId, requestedDestination, requiredString, tagsOf, titleOf } from './shared.ts'
import { graphql } from './graphql.ts'

// Current API contract: https://github.com/Hashnode/gql-skill/tree/main/skills/gql-api/references
const BASE = 'https://gql-beta.hashnode.com'
const headers = (token: string) => ({ ...bearer(token), 'x-hashnode-client': 'agent-social' })
export const hashnodeProvider: NativeProvider = {
  platform: 'hashnode',
  async connect(ctx, input) {
    const token = requireSecret(input.credentials, 'accessToken')
    const id = requestedDestination(input)
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const data = await graphql<{ me: { id: string }; publication: { id: string; title: string; url: string } }>(ctx, BASE, headers(token),
      'query Connection($id: ObjectId!) { me { id } publication(id: $id) { id title url } }', { id })
    if (!data.me?.id || data.publication?.id !== id) throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    return [{ platform: 'hashnode', remoteId: id, displayName: requiredString(data.publication.title), profileUrl: publicHttpsUrl(data.publication.url),
      metadata: { publicationId: id, userId: data.me.id }, credentials: { secrets: { accessToken: token } } }]
  },
  async publish(ctx, input) {
    if (input.media.length > 1 || input.media.some(media => !media.mime.startsWith('image/'))) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const variables: Record<string, unknown> = { publicationId: input.account.remoteId, title: titleOf(input), contentMarkdown: input.text,
      tags: tagsOf(input.settings).map(tag => ({ slug: tag.toLowerCase().replace(/[^a-z0-9-]/g, '-'), name: tag })) }
    const subtitle = stringSetting(input.settings, 'subtitle'); if (subtitle) variables.subtitle = subtitle
    const canonical = stringSetting(input.settings, 'canonical_url'); if (canonical) variables.originalArticleURL = canonical
    if (input.media[0]) {
      const media = input.media[0]; const auth = headers(requireSecret(input.account, 'accessToken'))
      const prepared = await graphql<{ createImageUploadURL: { presignedPut: { url: string; key: string } } }>(ctx, BASE, auth,
        'mutation Prepare($input: CreateImageUploadInput!) { createImageUploadURL(input: $input) { presignedPut { url key } } }', { input: { contentType: media.mime } })
      const upload = prepared.createImageUploadURL?.presignedPut
      const target = new URL(requiredString(upload?.url)); instanceUrl(`${target.origin}${target.pathname}`)
      await nativeRequest(ctx, target, { method: 'PUT', headers: { 'content-type': media.mime }, body: await mediaBlob(ctx, media), responseType: 'text', timeoutMs: 120_000 })
      const confirmed = await graphql<{ confirmImageUpload: { ok: boolean; cdnUrl: string | null } }>(ctx, BASE, auth,
        'mutation Confirm($input: ConfirmImageUploadInput!) { confirmImageUpload(input: $input) { ok cdnUrl } }', { input: { key: requiredString(upload.key) } })
      const url = publicHttpsUrl(confirmed.confirmImageUpload?.cdnUrl)
      if (!confirmed.confirmImageUpload?.ok || !url) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
      variables.coverImage = url
    }
    const data = await graphql<{ publishPost: { post: { id: string; url: string } } }>(ctx, BASE, headers(requireSecret(input.account, 'accessToken')),
      'mutation Publish($input: PublishPostInput!) { publishPost(input: $input) { post { id url } } }', { input: variables }, true)
    return { remoteId: publishedId(data.publishPost?.post?.id), remoteUrl: publicHttpsUrl(data.publishPost?.post?.url), status: 'published' }
  },
}
