import Link from 'next/link'
import { posts } from '@/lib/posts'

export default function HomePage() {
  return (
    <>
      <h1>Driftwatch fixture app</h1>
      <p className="meta">
        Four routes, a chart, and a couple of real dependencies — enough that a build takes long
        enough to time honestly.
      </p>
      {posts.slice(0, 2).map((post) => (
        <article key={post.slug}>
          <Link href={`/blog/${post.slug}`}>{post.title}</Link>
          <p className="meta">
            {post.publishedAt} · {post.readingMinutes} min
          </p>
        </article>
      ))}
    </>
  )
}
