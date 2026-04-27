export const onRequest: PagesFunction = async (context) => {
  const fqdn = context.params.fqdn as string;
  try {
    const resp = await fetch(`https://eyecx-api.kjssamsungdev.workers.dev/marketplace/domain/${fqdn}`);
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'text/html',
        'Cache-Control': resp.headers.get('Cache-Control') || 'public, max-age=300',
      },
    });
  } catch {
    return new Response('Service temporarily unavailable', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
};
