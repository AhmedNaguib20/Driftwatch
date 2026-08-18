import Link from 'next/link'
import { posts } from '@/lib/posts'

export default function BlogIndex() {
  return (
    <>
      <h1>Blog</h1>
      {posts.map((post) => (
        <article key={post.slug}>
          <Link href={`/blog/${post.slug}`}>{post.title}</Link>
          <p className="meta">
            {post.publishedAt} · {post.readingMinutes} min · {post.excerpt}
          </p>
        </article>
      ))}
    </>
  )
}
