export default {
  async fetch(request, env, ctx) {
    console.log("Worker intercepted:", request.url);
    const url = new URL(request.url);

    // 1. API Routes
    if (url.pathname === '/api/home-data') {
      return await handleHomeData(request, env, ctx);
    }

    // 2. SPA Routing & Static Assets
    // Try to fetch the requested asset
    let response = await env.ASSETS.fetch(request);
    
    // If asset not found, serve index.html ONLY for SPA navigation routes
    // Do NOT serve index.html for missing .js or .css files (which breaks the browser cache)
    if (response.status === 404 && request.headers.get('accept')?.includes('text/html')) {
      // Fetching "/" instead of "/index.html" prevents Cloudflare ASSETS from issuing a 307 canonical redirect
      const indexReq = new Request(url.origin + "/", request);
      response = await env.ASSETS.fetch(indexReq);
    }

    return response;
  }
};

async function handleHomeData(request, env, ctx) {
  const KV = env.MOVIES_KV;
  const CACHE_KEY = "home_data_v2";
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
        const [newRes, leRes, boRes, hhRes, ...amPages] = await Promise.all([
          fetch('https://ophim1.com/danh-sach/phim-moi-cap-nhat?page=1').then(r => r.json()),
          fetch('https://ophim1.com/v1/api/danh-sach/phim-le?page=1').then(r => r.json()),
          fetch('https://ophim1.com/v1/api/danh-sach/phim-bo?page=1').then(r => r.json()),
          fetch('https://ophim1.com/v1/api/danh-sach/hoat-hinh?page=1').then(r => r.json()),
          fetch('https://ophim1.com/v1/api/quoc-gia/au-my?page=1').then(r => r.json()),
          fetch('https://ophim1.com/v1/api/quoc-gia/au-my?page=2').then(r => r.json()),
          fetch('https://ophim1.com/v1/api/quoc-gia/au-my?page=3').then(r => r.json()),
          fetch('https://ophim1.com/v1/api/quoc-gia/au-my?page=4').then(r => r.json()),
          fetch('https://ophim1.com/v1/api/quoc-gia/au-my?page=5').then(r => r.json()),
        ]);

        const auMyItems = amPages.flatMap(page => page.data?.items || page.items || []);

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
          auMy: { items: auMyItems },
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
