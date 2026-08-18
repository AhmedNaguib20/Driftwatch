import { z } from 'zod'
import { format, subDays } from 'date-fns'

export const postSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  excerpt: z.string(),
  publishedAt: z.string(),
  readingMinutes: z.number().int().positive(),
})

export type Post = z.infer<typeof postSchema>

const seed = [
  ['measuring-what-matters', 'Measuring what matters', 'Why indirect signals still earn their place.', 6],
  ['the-noise-floor', 'The noise floor', 'Shared runners drift 20-30% on identical code.', 4],
  ['baselines-without-stashing', 'Baselines without stashing', 'git worktree, a temp dir, and no lost work.', 8],
  ['bundle-size-is-a-proxy', 'Bundle size is a proxy', 'It proves something changed, not that it got slower.', 5],
] as const

export const posts: Post[] = seed.map(([slug, title, excerpt, readingMinutes], i) =>
  postSchema.parse({
    slug,
    title,
    excerpt,
    publishedAt: format(subDays(new Date('2026-08-18T00:00:00Z'), i * 9), 'yyyy-MM-dd'),
    readingMinutes,
  }),
)

export function getPost(slug: string): Post | undefined {
  return posts.find((p) => p.slug === slug)
}
