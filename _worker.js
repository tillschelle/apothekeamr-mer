/**
 * Cloudflare Pages _worker.js
 * Handles /api/notdienst — alles andere → statische Dateien (index.html)
 */

// ── Koordinaten Apotheke am Römer, Bingen ──
const AAR_LAT = 49.9661;
const AAR_LNG = 7.8991;

const WEEKDAYS = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'];

function getMondayOfWeek(weekStr) {
  const [yearStr, weekPart] = weekStr.split('-W');
  const year = parseInt(yearStr);
  const week = parseInt(weekPart);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (week - 1) * 7);
  return monday;
}

function formatDate(d) {
  return `${String(d.getUTCDate()).padStart(2,'0')}.${String(d.getUTCMonth()+1).padStart(2,'0')}.${d.getUTCFullYear()}`;
}

async function fetchPharmacyForDate(dateStr) {
  const body = new URLSearchParams({
    'tx_aponetpharmacy_search[action]':           'search',
    'tx_aponetpharmacy_search[controller]':       'Search',
    'tx_aponetpharmacy_search[search][plzort]':   '55411 Bingen am Rhein',
    'tx_aponetpharmacy_search[search][date]':     dateStr,
    'tx_aponetpharmacy_search[search][radius]':   '30',
    'tx_aponetpharmacy_search[search][street]':   '',
  });
  const r = await fetch('https://www.aponet.de/notdienstsuche', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept':       'text/html,application/xhtml+xml',
      'Referer':      'https://www.aponet.de/notdienstsuche',
      'Origin':       'https://www.aponet.de',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error(`aponet HTTP ${r.status}`);
  return r.text();
}

function parseFirstPharmacy(html) {
  const nameM  = html.match(/<h2[^>]*class="[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/h2>/i) || html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const name   = nameM ? nameM[1].replace(/<[^>]+>/g,'').trim() : '';
  if (!name) return null;

  const streetM = html.match(/<span[^>]*class="[^"]*strasse[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  const street  = streetM ? streetM[1].replace(/<[^>]+>/g,'').trim() : '';

  const plzM = html.match(/<span[^>]*class="[^"]*plz[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  const plz  = plzM ? plzM[1].replace(/<[^>]+>/g,'').trim() : '';

  const ortM = html.match(/<span[^>]*class="[^"]*ort[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  const city = ortM ? ortM[1].replace(/<[^>]+>/g,'').trim() : '';

  const telM  = html.match(/href="tel:([^"]+)"/i);
  const phone = telM ? telM[1].replace(/\s+/g,'').replace(/^\+49/,'0') : '';

  const latM = html.match(/data-latitude="([^"]+)"/i);
  const lngM = html.match(/data-longitude="([^"]+)"/i);
  const lat  = latM ? parseFloat(latM[1]) : null;
  const lng  = lngM ? parseFloat(lngM[1]) : null;

  return { name, street, plz, city, phone, lat, lng };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

async function getDrivingKm(lat1, lng1, lat2, lng2) {
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=false`,{signal:AbortSignal.timeout(5000)});
    const d = await r.json();
    if (d.routes?.[0]) return d.routes[0].distance/1000;
  } catch {}
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── API-Route ──
    if (url.pathname === '/api/notdienst') {
      const week = url.searchParams.get('week') || '';

      if (!/^\d{4}-W\d{1,2}$/.test(week)) {
        return Response.json({ error: 'Format: 2026-W21' }, { status: 400 });
      }

      const monday = getMondayOfWeek(week);
      const dates  = Array.from({length:7}, (_,i) => {
        const d = new Date(monday); d.setUTCDate(monday.getUTCDate()+i); return formatDate(d);
      });

      const htmlResults = await Promise.allSettled(dates.map(fetchPharmacyForDate));

      const days = await Promise.all(htmlResults.map(async (res, i) => {
        const base = { weekday: WEEKDAYS[i], date: dates[i] };
        if (res.status === 'rejected') return { ...base, error: res.reason?.message };

        const p = parseFirstPharmacy(res.value);
        if (!p) return { ...base, error: 'Keine Apotheke gefunden' };

        const hasGps   = p.lat !== null && p.lng !== null;
        const aerialKm = hasGps ? Math.round(haversineKm(AAR_LAT,AAR_LNG,p.lat,p.lng)*10)/10 : null;
        const driveRaw = hasGps ? await getDrivingKm(AAR_LAT,AAR_LNG,p.lat,p.lng) : null;
        const drivingKm = driveRaw !== null ? Math.round(driveRaw*10)/10 : null;

        return { ...base, name:p.name, street:p.street, plz:p.plz, city:p.city, phone:p.phone, aerialKm, drivingKm };
      }));

      return Response.json(
        { week, days, filled: days.filter(d=>d.name).length },
        { headers: {
          'Cache-Control':               'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
          'Access-Control-Allow-Origin': '*',
        }}
      );
    }

    // ── Alles andere → statische Dateien ──
    return env.ASSETS.fetch(request);
  }
};
