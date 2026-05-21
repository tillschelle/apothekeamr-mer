/**
 * Cloudflare Pages Function: /api/notdienst
 *
 * Gibt den Notdienst-Wochenplan für PLZ 55411 Bingen als JSON zurück.
 * Aufruf: GET /api/notdienst?week=2026-W21
 *
 * Ablauf:
 *  1. ISO-Woche → 7 Datums-Strings (Mo–So)
 *  2. 7 parallele POST-Requests an aponet.de (je ein Tag)
 *  3. HTML per Regex parsen → Name, Adresse, Telefon, GPS
 *  4. Entfernung: Luftlinie (Haversine) + Auto (OSRM)
 *  5. JSON zurückgeben mit Cache-Headern (7 Tage Cloudflare-Edge)
 */

// ── Koordinaten Apotheke am Römer, Bingen ──
const AAR_LAT = 49.9661;
const AAR_LNG = 7.8991;

const WEEKDAYS = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'];

// ── ISO-Woche → Montag als UTC-Date ──
function getMondayOfWeek(weekStr) {
  const [yearStr, weekPart] = weekStr.split('-W');
  const year = parseInt(yearStr);
  const week = parseInt(weekPart);
  // ISO 8601: 4. Januar liegt immer in KW 1
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // 1=Mo … 7=So
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (week - 1) * 7);
  return monday;
}

function formatDate(d) {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

// ── POST an aponet.de für einen Datum-String (DD.MM.YYYY) ──
async function fetchPharmacyForDate(dateStr) {
  const body = new URLSearchParams({
    'tx_aponetpharmacy_search[action]':               'search',
    'tx_aponetpharmacy_search[controller]':           'Search',
    'tx_aponetpharmacy_search[search][plzort]':       '55411 Bingen am Rhein',
    'tx_aponetpharmacy_search[search][date]':         dateStr,
    'tx_aponetpharmacy_search[search][radius]':       '30',
    'tx_aponetpharmacy_search[search][street]':       '',
  });

  const r = await fetch('https://www.aponet.de/notdienstsuche', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept':        'text/html,application/xhtml+xml',
      'Referer':       'https://www.aponet.de/notdienstsuche',
      'Origin':        'https://www.aponet.de',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(9000),
  });

  if (!r.ok) throw new Error(`aponet HTTP ${r.status} für ${dateStr}`);
  return await r.text();
}

// ── HTML parsen: erste Apotheke aus der Ergebnisliste ──
function parseFirstPharmacy(html) {
  // Name
  const nameM = html.match(/<h2[^>]*class="[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/h2>/i)
             || html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const name = nameM ? nameM[1].replace(/<[^>]+>/g, '').trim() : '';
  if (!name) return null;

  // Adresse
  const streetM = html.match(/<span[^>]*class="[^"]*strasse[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  const street  = streetM ? streetM[1].replace(/<[^>]+>/g, '').trim() : '';

  const plzM = html.match(/<span[^>]*class="[^"]*plz[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  const plz  = plzM ? plzM[1].replace(/<[^>]+>/g, '').trim() : '';

  const ortM = html.match(/<span[^>]*class="[^"]*ort[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  const city = ortM ? ortM[1].replace(/<[^>]+>/g, '').trim() : '';

  // Telefon (href="tel:...")
  const telM  = html.match(/href="tel:([^"]+)"/i);
  const phone = telM
    ? telM[1].replace(/\s+/g, '').replace(/^\+49/, '0')
    : '';

  // GPS-Koordinaten aus data-Attributen
  const latM = html.match(/data-latitude="([^"]+)"/i);
  const lngM = html.match(/data-longitude="([^"]+)"/i);
  const lat  = latM ? parseFloat(latM[1]) : null;
  const lng  = lngM ? parseFloat(lngM[1]) : null;

  return { name, street, plz, city, phone, lat, lng };
}

// ── Luftlinie (Haversine) ──
function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180)
             * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Auto-Routing via OSRM (kostenlos, kein API-Key) ──
async function getDrivingKm(lat1, lng1, lat2, lng2) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/`
              + `${lng1},${lat1};${lng2},${lat2}?overview=false`;
    const r    = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    if (data.routes?.[0]) return data.routes[0].distance / 1000;
  } catch {}
  return null;
}

// ── Haupt-Handler ──
export async function onRequestGet({ request }) {
  const url  = new URL(request.url);
  const week = url.searchParams.get('week') || '';

  // Validierung
  if (!/^\d{4}-W\d{1,2}$/.test(week)) {
    return Response.json(
      { error: 'Ungültiges Format. Erwartet z. B.: 2026-W21' },
      { status: 400 }
    );
  }

  const monday = getMondayOfWeek(week);

  // 7 Datums-Strings (Mo–So)
  const dates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return formatDate(d);
  });

  // 7 parallele aponet-Requests
  const htmlResults = await Promise.allSettled(
    dates.map(date => fetchPharmacyForDate(date))
  );

  // Parsen + Distanzen parallel berechnen
  const days = await Promise.all(
    htmlResults.map(async (result, i) => {
      const base = { weekday: WEEKDAYS[i], date: dates[i] };

      if (result.status === 'rejected') {
        return { ...base, error: result.reason?.message ?? 'Fehler' };
      }

      const pharmacy = parseFirstPharmacy(result.value);
      if (!pharmacy) {
        return { ...base, error: 'Keine Apotheke im Ergebnis' };
      }

      const hasGps = pharmacy.lat !== null && pharmacy.lng !== null;

      const aerialKm = hasGps
        ? Math.round(haversineKm(AAR_LAT, AAR_LNG, pharmacy.lat, pharmacy.lng) * 10) / 10
        : null;

      const drivingRaw = hasGps
        ? await getDrivingKm(AAR_LAT, AAR_LNG, pharmacy.lat, pharmacy.lng)
        : null;
      const drivingKm = drivingRaw !== null
        ? Math.round(drivingRaw * 10) / 10
        : null;

      return {
        ...base,
        name:      pharmacy.name,
        street:    pharmacy.street,
        plz:       pharmacy.plz,
        city:      pharmacy.city,
        phone:     pharmacy.phone,
        aerialKm,
        drivingKm,
      };
    })
  );

  const filled = days.filter(d => d.name).length;

  return Response.json(
    { week, days, filled },
    {
      headers: {
        // Browser: 24h, Cloudflare-Edge: 7 Tage, stale-while-revalidate: 24h
        'Cache-Control':                'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
        'Access-Control-Allow-Origin':  '*',
      },
    }
  );
}
