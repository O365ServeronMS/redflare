export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. API Routes
    if (url.pathname === '/api/home-data') {
      return await handleHomeData(request, env, ctx);
    }

    // 2. SPA Routing & Static Assets
    // Try to fetch the requested asset
    let response = await env.ASSETS.fetch(request);
    
    // If asset not found (e.g. /phim/slug), serve index.html for SPA router
    if (response.status === 404) {
      // Cloudflare Assets automatically redirects /index.html to / to normalize URLs.
      // Fetching / directly avoids this 301/302 redirect and returns the HTML content cleanly.
      const indexReq = new Request(url.origin + "/", request);
      response = await env.ASSETS.fetch(indexReq);
    }

    return response;
  }
};

async function handleHomeData(request, env, ctx) {
  const KV = env.MOVIES_KV;
  const CACHE_KEY = "home_data";
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Cache-Control": "public, s-maxage=1800, max-age=1800",
  };

  try {
    let cachedStr = null;
    if (KV) {
      cachedStr = await KV.get(CACHE_KEY);
    }
    
    let cachedData = null;
    if (cachedStr) {
      cachedData = JSON.parse(cachedStr);
    }

    const fetchFreshData = async () => {
      try {
        const [newRes, leRes, boRes, hhRes, amRes] = await Promise.all([
          fetch('https://ophim1.com/danh-sach/phim-moi-cap-nhat?page=1').then(r => r.json()),
          fetch('https://ophim1.com/v1/api/danh-sach/phim-le?page=1').then(r => r.json()),
          fetch('https://ophim1.com/v1/api/danh-sach/phim-bo?page=1').then(r => r.json()),
          fetch('https://ophim1.com/v1/api/danh-sach/hoat-hinh?page=1').then(r => r.json()),
          fetch('https://ophim1.com/v1/api/quoc-gia/au-my?page=1').then(r => r.json()),
        ]);

        const freshData = {
          timestamp: Date.now(),
          newMovies: {
            items: newRes.items || [],
            pagination: newRes.pagination || {},
            pathImage: newRes.pathImage || 'https://img.ophim.live/uploads/movies/',
          },
          phimLe: { items: (leRes.data?.items || leRes.items || []) },
          phimBo: { items: (boRes.data?.items || boRes.items || []) },
          hoatHinh: { items: (hhRes.data?.items || hhRes.items || []) },
          auMy: { items: (amRes.data?.items || amRes.items || []) },
        };

        if (KV) {
          await KV.put(CACHE_KEY, JSON.stringify(freshData));
        }
        return freshData;
      } catch (err) {
        console.error("Error fetching fresh data:", err);
        return null;
      }
    };

    // SWR Logic
    if (cachedData) {
      if (Date.now() - cachedData.timestamp > CACHE_TTL_MS) {
        if (ctx && ctx.waitUntil) {
          ctx.waitUntil(fetchFreshData());
        } else {
          fetchFreshData();
        }
      }
      return new Response(JSON.stringify(cachedData), { headers: corsHeaders });
    } else {
      const freshData = await fetchFreshData();
      if (!freshData) {
        return new Response(JSON.stringify({ error: "Failed to fetch data from OPhim" }), { 
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify(freshData), { headers: corsHeaders });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
