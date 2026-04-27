export const onRequest: PagesFunction = async () => {
  try {
    const resp = await fetch('https://eyecx-api.kjssamsungdev.workers.dev/sitemap-blog.xml');
    return new Response(resp.body, {
      headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=3600' },
    });
  } catch {
    return new Response('Service temporarily unavailable', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
};
