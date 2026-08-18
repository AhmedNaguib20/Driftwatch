import { notFound } from 'next/navigation'
import { getPost, posts } from '@/lib/posts'

export function generateStaticParams() {
  return posts.map((post) => ({ slug: post.slug }))
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = getPost(slug)
  if (!post) notFound()

  return (
    <>
      <h1>{post.title}</h1>
      <p className="meta">
        {post.publishedAt} · {post.readingMinutes} min
      </p>
      <p>{post.excerpt}</p>
    </>
  )
}
