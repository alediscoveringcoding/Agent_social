import { bearer, nativeRequest, NativeProviderError } from '../http.ts'
import { requireSecret, stringSetting, type NativeProvider } from '../types.ts'
import { graphql } from './graphql.ts'
import { publicHttpsUrl, publishedId, requestedDestination, requiredString, titleOf } from './shared.ts'

const BASE = 'https://api.github.com'
const headers = (token: string) => ({ ...bearer(token), accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10' })
function repository(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
  return value.split('/').map(encodeURIComponent).join('/')
}
/** https://docs.github.com/en/rest/releases/releases#create-a-release */
export const githubProvider: NativeProvider = {
  platform: 'github',
  async connect(ctx, input) {
    const token = requireSecret(input.credentials, 'accessToken'); const repo = repository(requestedDestination(input))
    const { data } = await nativeRequest<{ full_name: string; node_id: string; html_url: string; permissions?: { push?: boolean } }>(ctx, `${BASE}/repos/${repo}`, { headers: headers(token) })
    if (data.permissions?.push !== true) throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    return [{ platform: 'github', remoteId: requiredString(data.full_name), displayName: data.full_name, profileUrl: publicHttpsUrl(data.html_url),
      metadata: { repositoryNodeId: requiredString(data.node_id) }, credentials: { secrets: { accessToken: token } } }]
  },
  async publish(ctx, input) {
    const repo = repository(input.account.remoteId); const selected = stringSetting(input.settings, 'repo')
    if (selected.toLowerCase() !== input.account.remoteId.toLowerCase()) throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    if (input.media.length) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const auth = headers(requireSecret(input.account, 'accessToken'))
    const body = input.text
    if (stringSetting(input.settings, 'post_type', 'release') === 'discussion') {
      const [owner, name] = input.account.remoteId.split('/')
      const data = await graphql<{ repository: { id: string; discussionCategories: { nodes: Array<{ id: string; name: string; slug: string }> } } }>(ctx, `${BASE}/graphql`, auth,
        'query Categories($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id discussionCategories(first: 100) { nodes { id name slug } } } }', { owner, name })
      const selectedCategory = stringSetting(input.settings, 'category')
      const category = data.repository?.discussionCategories.nodes.find(item => [item.id, item.name, item.slug].includes(selectedCategory))
      if (!category) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
      const sent = await graphql<{ createDiscussion: { discussion: { id: string; url: string } } }>(ctx, `${BASE}/graphql`, auth,
        'mutation Publish($input: CreateDiscussionInput!) { createDiscussion(input: $input) { discussion { id url } } }',
        { input: { repositoryId: data.repository.id, categoryId: category.id, title: titleOf(input), body, clientMutationId: input.jobId } }, true)
      return { remoteId: publishedId(sent.createDiscussion?.discussion?.id), remoteUrl: publicHttpsUrl(sent.createDiscussion?.discussion?.url), status: 'published' }
    }
    const tag = stringSetting(input.settings, 'tag')
    if (!tag || /\s/.test(tag)) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const { data } = await nativeRequest<{ id: number; html_url: string }>(ctx, `${BASE}/repos/${repo}/releases`, {
      method: 'POST', headers: auth, body: { tag_name: tag, name: titleOf(input), body, draft: false, generate_release_notes: false }, write: true,
    })
    return { remoteId: publishedId(data?.id), remoteUrl: publicHttpsUrl(data?.html_url), status: 'published' }
  },
}
