export const onRequest: PagesFunction = async () => {
  const resp = await fetch('https://eyecx-api.kjssamsungdev.workers.dev/sitemap-domains.xml');
  return new Response(resp.body, {
    headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=3600' },
  });
};
