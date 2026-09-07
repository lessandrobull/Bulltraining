export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'Webhook ativo e pronto' });
  }

  const API_KEY = '3pcp8m39g3wupqh688l1zcvtf';
  const ATHLETE_ID = 'i704231';
  const SUPABASE_URL = 'https://xttzilpuuqjbztjkeadd.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_uexabKupvCYRAAPqRiETSQ_I01UsSZI';

  const authHeader = 'Basic ' + Buffer.from('API_KEY:' + API_KEY).toString('base64');

  try {
    const body = req.body || {};
    
    // Captura o ID da atividade tanto em lote quanto direto
    let activityId = null;
    if (body.events && body.events.length > 0) {
      activityId = body.events[0].activity_id || body.events[0].id;
    } else {
      activityId = body.activity_id || body.activityId || body.id || req.query.activity_id;
    }

    if (!activityId) {
      return res.status(200).json({ message: 'Evento recebido, mas sem activity_id válido.' });
    }

    // 1. Buscar detalhes completos da atividade no Intervals.icu
    const actRes = await fetch(`https://intervals.icu/api/v1/activity/${activityId}`, {
      headers: { Authorization: authHeader }
    });

    if (!actRes.ok) {
      return res.status(actRes.status).json({ error: 'Erro ao buscar treino no Intervals.icu' });
    }

    const act = await actRes.json();

    // 2. Buscar pontos para altimetria e FC
    let trackpoints = [];
    try {
      const streamRes = await fetch(`https://intervals.icu/api/v1/activity/${activityId}/streams?types=time,distance,heartrate,altitude`, {
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

    // 3. Montar voltas (Splits)
    const laps = (act.laps || []).map((l, idx) => ({
      lap: idx + 1,
      seconds: l.moving_time || l.elapsed_time || 0,
      meters: l.distance || 0,
      avgHr: Math.round(l.average_heartrate || 0),
      maxHr: Math.round(l.max_heartrate || 0)
    }));

    // 4. Buscar zonas no Supabase
    let hrRest = 50;
    let hrMax = 185;
    try {
      const settingsRes = await fetch(`${SUPABASE_URL}/rest/v1/user_settings?id=eq.1&select=*`, {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      });
      const settingsData = await settingsRes.json();
      if (settingsData && settingsData[0]) {
        hrRest = settingsData[0].hr_rest || 50;
        hrMax = settingsData[0].hr_max || 185;
      }
    } catch (e) {
      console.warn('Usando padrões de FC:', e);
    }

    // 5. Cálculo do TRIMP
    const avgHr = Math.round(act.average_heartrate || 0);
    const durationSecs = act.moving_time || act.elapsed_time || 0;
    const durationMin = durationSecs / 60;
    const hrRatio = avgHr > hrRest ? (avgHr - hrRest) / (hrMax - hrRest) : 0;
    const trimp = durationMin * hrRatio * 0.64 * Math.exp(1.92 * hrRatio);

    // 6. Gravar no Supabase
    const supabasePayload = {
      start_time: act.start_date_local || act.start_date,
      sport: (act.type || 'running').toLowerCase(),
      distance_meters: act.distance || 0,
      duration_seconds: durationSecs,
      avg_heart_rate: avgHr,
      max_heart_rate: Math.round(act.max_heartrate || 0),
      trimp_score: trimp,
      laps: laps,
      trackpoints: trackpoints
    };

    const supaRes = await fetch(`${SUPABASE_URL}/rest/v1/workouts`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify(supabasePayload)
    });

    if (!supaRes.ok) {
      const supaErr = await supaRes.text();
      return res.status(500).json({ error: 'Erro ao salvar no Supabase', details: supaErr });
    }

    return res.status(200).json({ success: true, activity: act.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
