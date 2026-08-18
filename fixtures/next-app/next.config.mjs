/** @type {import('next').NextConfig} */
const nextConfig = {
  // Deterministic builds matter more than speed here — this fixture exists to prove that two
  // measurements of an unchanged tree report "no change".
  reactStrictMode: true,
  poweredByHeader: false,
}

export default nextConfig
