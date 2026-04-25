export const onRequest: PagesFunction = async () => {
  return new Response(`User-agent: *
Allow: /
Allow: /marketplace
Allow: /blog
Allow: /community
Allow: /docs
Disallow: /admin
Disallow: /login
Disallow: /register
Disallow: /api/admin/
Disallow: /api/auth/
Disallow: /v1/

Sitemap: https://eyecx.com/sitemap.xml
`, { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' } });
};
