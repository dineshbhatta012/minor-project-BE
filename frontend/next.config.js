/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/stops/:path*', destination: 'http://localhost:8000/stops/:path*' },
      { source: '/route/:path*', destination: 'http://localhost:8000/route/:path*' },
      { source: '/health', destination: 'http://localhost:8000/health' },
      { source: '/api/:path*', destination: 'http://localhost:8000/:path*' },
    ];
  },
};

module.exports = nextConfig;
