/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'edge';

/** Only allow proxying to DYTT video CDN domains (vip.dytt-*.com) */
const DYTT_DOMAIN_RE = /^vip\.dytt-\w+\.com$/;

function isAllowed(url: string): boolean {
  try {
    return DYTT_DOMAIN_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Rewrite every segment / sub-playlist / key reference inside an m3u8
 * so that HLS.js fetches them through our proxy too.
 */
function rewriteM3u8(raw: string, m3u8Url: string): string {
  const prefix = '/api/proxy?url=';
  return raw
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (t === '') return line;

      // Rewrite URI="…" in EXT-X-KEY / EXT-X-MAP tags
      if (t.startsWith('#') && /URI="([^"]+)"/.test(t)) {
        return t.replace(/URI="([^"]+)"/g, (_, uri) => {
          const abs = new URL(uri, m3u8Url).href;
          return `URI="${prefix}${encodeURIComponent(abs)}"`;
        });
      }

      // Other comment/tag lines – pass through
      if (t.startsWith('#')) return line;

      // Segment or variant-playlist URL → resolve to absolute, then proxy
      const abs = new URL(t, m3u8Url).href;
      return `${prefix}${encodeURIComponent(abs)}`;
    })
    .join('\n');
}

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get('url');

  if (!target) {
    return NextResponse.json(
      { error: 'Missing url parameter' },
      { status: 400 }
    );
  }

  if (!isAllowed(target)) {
    return NextResponse.json({ error: 'Domain not allowed' }, { status: 403 });
  }

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 15_000);

    const resp = await fetch(target, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Referer: new URL(target).origin + '/',
      },
      signal: ctrl.signal,
    });
    clearTimeout(tid);

    if (!resp.ok) {
      return new NextResponse(null, {
        status: resp.status,
        statusText: resp.statusText,
      });
    }

    const ct = resp.headers.get('content-type') || '';
    const isM3u8 =
      target.endsWith('.m3u8') || ct.includes('mpegurl') || ct.includes('m3u8');

    if (isM3u8) {
      const body = await resp.text();
      const rewritten = rewriteM3u8(body, target);
      return new NextResponse(rewritten, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // .ts segments, .key files, etc. → stream binary through
    return new NextResponse(resp.body, {
      headers: {
        'Content-Type': ct || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (err) {
    console.error('[Proxy]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Proxy failed' },
      { status: 502 }
    );
  }
}
