/**
 * Request bodies of the worker API (PRD 10.3) and the Draft / card spec it
 * receives from the generator (PRD 10.5). The OpenAPI file in the infra repo
 * (docs/contracts/worker-api.openapi.yaml) describes the same shapes.
 *
 * Unknown keys are dropped rather than refused, so the worker can add a field
 * before the site reads it without breaking anything.
 */

import { z } from 'zod'
import { CARD_TEMPLATES, DELIVERY_OUTCOMES, PLATFORMS, POST_KINDS } from './constants.ts'

const httpUrl = z
  .string()
  .max(2048)
  .refine((v) => /^https?:\/\/[^\s]+$/i.test(v), 'must be an http(s) URL')

const errorCode = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'UPPER_SNAKE_CASE')

export const ClaimBody = z.object({
  limit: z.number().int().min(1).max(5).optional(),
})

export const AttemptBody = z.object({
  attempt_no: z.number().int().min(1),
})

export const SubmittedBody = z.object({
  attempt_no: z.number().int().min(1),
  postiz_post_id: z.string().min(1).max(200),
  postiz_group: z.string().max(200).nullish(),
})

export const ResultBody = z
  .object({
    attempt_no: z.number().int().min(1),
    outcome: z.enum(DELIVERY_OUTCOMES),
    remote_url: httpUrl.nullish(),
    error_code: errorCode.nullish(),
    error_message: z.string().max(4000).nullish(),
    retry_after_seconds: z.number().int().min(0).max(86400).nullish(),
  })
  .refine((b) => !(b.outcome === 'failed' || b.outcome === 'retry') || !!b.error_code, {
    message: 'error_code is required for failed and retry',
    path: ['error_code'],
  })

export const GenerationClaimBody = z.object({
  limit: z.number().int().min(1).max(5).optional(),
})

export const GenerationFailedBody = z.object({
  error_code: errorCode,
  error_message: z.string().max(4000).nullish(),
})

export const CardSpecSchema = z.object({
  template: z.enum(CARD_TEMPLATES),
  headline: z.string().max(200),
  keyword: z.string().max(200).nullish(),
  stat: z.string().max(32).nullish(),
  subline: z.string().max(400).nullish(),
  brand: z.string().max(64),
  alt_text: z.string().max(1000).nullish(),
})
export type CardSpecInput = z.infer<typeof CardSpecSchema>

export const FigureSchema = z.object({
  value: z.string().min(1).max(100),
  context: z.string().max(500).nullish(),
  source: z.string().min(1).max(32),
})

const settingsSchema = z.record(z.string(), z.unknown())

export const VariantSchema = z.object({
  platform: z.enum(PLATFORMS),
  text: z.string().max(100_000),
  settings: settingsSchema.nullish(),
})

export const ArticleSchema = z.object({
  title: z.string().max(300),
  subtitle: z.string().max(500).nullish(),
  body_markdown: z.string().max(200_000),
  tags: z.array(z.string().max(64)).max(20).nullish(),
  canonical_url: z.string().max(2048).nullish(),
})

export const LaunchSchema = z.object({
  name: z.string().max(200),
  tagline: z.string().max(200),
  description: z.string().max(2000),
  maker_comment: z.string().max(5000).nullish(),
})

export const DraftSchema = z.object({
  client_ref: z.string().min(1).max(64),
  kind: z.enum(POST_KINDS),
  title: z.string().max(300).nullish(),
  canonical_text: z.string().max(100_000),
  source_url: z.string().max(2048).nullish(),
  variants: z.array(VariantSchema).max(20),
  article: ArticleSchema.nullish(),
  launch: LaunchSchema.nullish(),
  card: CardSpecSchema.nullish(),
  figures: z.array(FigureSchema).max(100).default([]),
  validation_errors: z
    .array(z.union([z.string().max(2000), z.object({ code: z.string().max(64).optional(), message: z.string().max(2000) })]))
    .max(100)
    .default([]),
  notes: z.string().max(4000).nullish(),
})
export type DraftInput = z.infer<typeof DraftSchema>

export const DraftsBody = z.object({
  drafts: z.array(DraftSchema).min(1).max(50),
})

export const SyncBody = z.object({
  integrations: z
    .array(
      z.object({
        postiz_integration_id: z.string().min(1).max(200),
        provider: z.string().min(1).max(64),
        name: z.string().max(300),
        picture_url: z.string().max(2048).nullish(),
        profile_url: z.string().max(2048).nullish(),
        disabled: z.boolean().optional(),
        refresh_needed: z.boolean().optional(),
        rules: z.record(z.string(), z.unknown()).nullish(),
      })
    )
    .max(500),
  postiz_recent_posts: z
    .array(
      z.object({
        postiz_post_id: z.string().min(1).max(200),
        integration_id: z.string().min(1).max(200),
        created_at: z.string().max(64).nullish(),
      })
    )
    .max(2000)
    .optional(),
})

/** Generation input (PRD 10.5), as the admin form stores it. */
export const GenerationInputSchema = z.object({
  source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('article'), url: httpUrl }),
    z.object({
      type: z.literal('topic'),
      topic: z.string().min(3).max(500),
      hooks: z.array(z.string().max(100)).max(10).default([]),
    }),
  ]),
  platforms: z.array(z.enum(PLATFORMS)).min(1).max(PLATFORMS.length),
  kinds: z.array(z.enum(POST_KINDS)).min(1),
  count: z.number().int().min(1).max(20),
  language: z.literal('ro'),
  templates: z.array(z.enum(CARD_TEMPLATES)).min(1),
})
export type GenerationInput = z.infer<typeof GenerationInputSchema>
