export const onRequest: PagesFunction = async (context) => {
  const tld = context.params.tld as string;
  try {
    const resp = await fetch(`https://eyecx-api.kjssamsungdev.workers.dev/tld/${tld}`);
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'text/html',
        'Cache-Control': resp.headers.get('Cache-Control') || 'public, max-age=21600',
      },
    });
  } catch {
    return new Response('Service temporarily unavailable', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
};
