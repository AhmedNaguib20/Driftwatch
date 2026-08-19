import { posts } from '@/lib/posts'

// Rendered on every request — the route class Layer 2a exists to measure.
export const dynamic = 'force-dynamic'

export default function LivePage() {
  // Real server-side work per request: filter + sort + render.
  const featured = [...posts]
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))
    .filter((post) => post.readingMinutes > 3)
    .slice(0, 10)

  return (
    <>
      <h1>Live feed</h1>
      <p className="meta">Rendered at {new Date().toISOString()}</p>
      {featured.map((post) => (
        <article key={post.slug}>
          <strong>{post.title}</strong>
          <p className="meta">{post.publishedAt} · {post.readingMinutes} min · {post.excerpt}</p>
        </article>
      ))}
    </>
  )
}
