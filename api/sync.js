export default async function handler(req, res) {
  const API_KEY = '3pcp8m39g3wupqh688l1zcvtf';
  const ATHLETE_ID = 'i704231';
  const SUPABASE_URL = 'https://xttzilpuuqjbztjkeadd.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_uexabKupvCYRAAPqRiETSQ_I01UsSZI';

  const authHeader = 'Basic ' + Buffer.from('API_KEY:' + API_KEY).toString('base64');

  try {
    // 1. Buscar os últimos 5 treinos no Intervals.icu
    const listRes = await fetch(`https://intervals.icu/api/v1/athlete/${ATHLETE_ID}/activities?limit=5`, {
      headers: { Authorization: authHeader }
    });

    if (!listRes.ok) {
      return res.status(listRes.status).json({ error: 'Erro ao conectar ao Intervals.icu' });
    }

    const activities = await listRes.json();
    if (!Array.isArray(activities) || activities.length === 0) {
      return res.status(200).json({ message: 'Nenhum treino novo', synced: 0 });
    }

    // 2. Buscar treinos já gravados no Supabase
    const supaCheck = await fetch(`${SUPABASE_URL}/rest/v1/workouts?select=start_time`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    const existing = await supaCheck.json();
    const existingTimes = new Set((existing || []).map(w => w.start_time));

    // 3. Buscar configurações de FC
    let hrRest = 50;
    let hrMax = 185;
    try {
      const settingsRes = await fetch(`${SUPABASE_URL}/rest/v1/user_settings?id=eq.1&select=*`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      const settingsData = await settingsRes.json();
      if (settingsData && settingsData[0]) {
        hrRest = settingsData[0].hr_rest || 50;
        hrMax = settingsData[0].hr_max || 185;
      }
    } catch (e) {
      console.warn('Usando FC padrão:', e);
    }

    let syncedCount = 0;

    for (const act of activities) {
      const startTime = act.start_date_local || act.start_date;
      if (existingTimes.has(startTime)) continue;

      // Telemetria (FC, distância, altitude)
      let trackpoints = [];
      try {
        const streamRes = await fetch(`https://intervals.icu/api/v1/activity/${act.id}/streams?types=time,distance,heartrate,altitude`, {
          headers: { Authorization: authHeader }
        });
        if (streamRes.ok) {
          const streams = await streamRes.json();
          const distStream = streams.find(s => s.type === 'distance')?.data || [];
          const hrStream = streams.find(s => s.type === 'heartrate')?.data || [];
          const altStream = streams.find(s => s.type === 'altitude')?.data || [];

          for (let j = 0; j < distStream.length; j += 3) {
            trackpoints.push({
              dist: distStream[j] || 0,
              hr: hrStream[j] || 0,
              alt: altStream[j] || 0
            });
          }
        }
      } catch (e) {
        console.warn('Streams indisponíveis:', e);
      }

      // Splits por Km
      const laps = (act.laps || []).map((l, idx) => ({
        lap: idx + 1,
        seconds: l.moving_time || l.elapsed_time || 0,
        meters: l.distance || 0,
        avgHr: Math.round(l.average_heartrate || 0),
        maxHr: Math.round(l.max_heartrate || 0)
      }));

      // TRIMP
      const avgHr = Math.round(act.average_heartrate || 0);
      const durationSecs = act.moving_time || act.elapsed_time || 0;
      const durationMin = durationSecs / 60;
      const hrRatio = avgHr > hrRest ? (avgHr - hrRest) / (hrMax - hrRest) : 0;
      const trimp = durationMin * hrRatio * 0.64 * Math.exp(1.92 * hrRatio);

      // Inserir no Supabase
      await fetch(`${SUPABASE_URL}/rest/v1/workouts`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          start_time: startTime,
          sport: (act.type || 'running').toLowerCase(),
          distance_meters: act.distance || 0,
          duration_seconds: durationSecs,
          avg_heart_rate: avgHr,
          max_heart_rate: Math.round(act.max_heartrate || 0),
          trimp_score: trimp,
          laps: laps,
          trackpoints: trackpoints
        })
      });

      syncedCount++;
    }

    return res.status(200).json({ success: true, synced: syncedCount });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
