export default async function handler(req, res) {
  const API_KEY = process.env.INTERVALS_API_KEY;
  const ATHLETE_ID = process.env.INTERVALS_ATHLETE_ID || 'i704231';
  const SUPABASE_URL = 'https://xttzilpuuqjbztjkeadd.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_uexabKupvCYRAAPqRiETSQ_I01UsSZI';

  const authHeader = 'Basic ' + Buffer.from('API_KEY:' + API_KEY).toString('base64');

  try {
    // Se passar ?full=true na URL, busca todo o histórico (desde 2024). Senão, últimos 15 dias.
    const isFull = req.query.full === 'true';
    let oldest = req.query.oldest;

    if (!oldest) {
      if (isFull) {
        oldest = '2024-01-01';
      } else {
        const d = new Date();
        d.setDate(d.getDate() - 15);
        oldest = d.toISOString().split('T')[0];
      }
    }

    const listRes = await fetch(`https://intervals.icu/api/v1/athlete/${ATHLETE_ID}/activities?oldest=${oldest}`, {
      headers: { Authorization: authHeader }
    });

    if (!listRes.ok) {
      const errText = await listRes.text();
      return res.status(listRes.status).json({ error: 'Erro no Intervals.icu', details: errText });
    }

    const activities = await listRes.json();
    if (!Array.isArray(activities) || activities.length === 0) {
      return res.status(200).json({ message: 'Nenhum treino encontrado.', synced: 0 });
    }

    // Busca treinos existentes com métricas para servir de base histórica no fallback de TRIMP
    const supaCheck = await fetch(
      `${SUPABASE_URL}/rest/v1/workouts?select=id,start_time,sport,distance_meters,duration_seconds,avg_heart_rate,trimp_score,laps,trackpoints,is_deleted&order=start_time.desc`,
      {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      }
    );
    const existing = await supaCheck.json();
    const existingMap = new Map();
    (existing || []).forEach(w => {
      existingMap.set(w.start_time, w);
    });

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

    // --- CALIBRAÇÃO HISTÓRICA PARA FALLBACK DE TRIMP SEM SENSOR CARDÍACO ---
    const validHistory = (existing || []).filter(
      w => !w.is_deleted && w.avg_heart_rate > hrRest && w.duration_seconds > 300
    );

    // 1. Fator pessoal de Eficiência (hrRatio por m/s) para Corrida/Caminhada (últimos 30 treinos válidos)
    const validRuns = validHistory
      .filter(w => ['running', 'run', 'walking'].includes((w.sport || '').toLowerCase()) && w.distance_meters > 500)
      .slice(0, 30);

    let runEfficiencyFactor = 0.24; // Fallback de segurança caso ainda não haja histórico (ex: ~3.0 m/s -> hrRatio ~0.72)
    if (validRuns.length > 0) {
      const sumFactors = validRuns.reduce((acc, w) => {
        const ratio = (w.avg_heart_rate - hrRest) / (hrMax - hrRest);
        const speedMs = w.distance_meters / w.duration_seconds;
        return acc + (ratio / speedMs);
      }, 0);
      runEfficiencyFactor = sumFactors / validRuns.length;
    }

    // 2. Média de TRIMP por minuto por esporte (plano B para ciclismo ou treinos sem GPS)
    const sportTrimpPerMin = {};
    const sportCounts = {};
    validHistory.slice(0, 50).forEach(w => {
      const sp = (w.sport || 'running').toLowerCase();
      if (w.trimp_score > 0 && w.duration_seconds > 0) {
        const tpm = w.trimp_score / (w.duration_seconds / 60);
        sportTrimpPerMin[sp] = (sportTrimpPerMin[sp] || 0) + tpm;
        sportCounts[sp] = (sportCounts[sp] || 0) + 1;
      }
    });

    let syncedCount = 0;
    let updatedCount = 0;

    for (const act of activities) {
      const startTime = act.start_date_local || act.start_date;
      const existingWorkout = existingMap.get(startTime);

      // Verifica integridade do treino já salvo no banco
      const hasLaps = existingWorkout && Array.isArray(existingWorkout.laps) && existingWorkout.laps.length > 0;
      const hasPaceInTrackpoints =
        existingWorkout &&
        Array.isArray(existingWorkout.trackpoints) &&
        existingWorkout.trackpoints.length > 0 &&
        existingWorkout.trackpoints.some(tp => tp.pace !== null && tp.pace !== undefined);
      const hasBuggyLaps =
        existingWorkout &&
        Array.isArray(existingWorkout.laps) &&
        existingWorkout.laps.some(l => (l.seconds || 0) <= 5);
      // Detecta se o treino ficou com TRIMP zerado por falha no sensor cardíaco
      const hasZeroTrimp =
        existingWorkout &&
        (existingWorkout.duration_seconds || 0) > 60 &&
        (!existingWorkout.trimp_score || existingWorkout.trimp_score <= 0);

      if (hasLaps && hasPaceInTrackpoints && !hasBuggyLaps && !hasZeroTrimp) {
        continue;
      }

      let trackpoints = [];
      let timeStream = [];
      let distStream = [];
      let hrStream = [];
      let altStream = [];

      try {
        let streamRes = await fetch(`https://intervals.icu/api/v1/activity/${act.id}/streams.json`, {
          headers: { Authorization: authHeader }
        });

        if (!streamRes.ok) {
          streamRes = await fetch(`https://intervals.icu/api/v1/activity/${act.id}/streams?types=time,distance,heartrate,altitude`, {
            headers: { Authorization: authHeader }
          });
        }

        if (streamRes.ok) {
          const streams = await streamRes.json();
          timeStream = streams.find(s => s.type === 'time')?.data || [];
          distStream = streams.find(s => s.type === 'distance')?.data || [];
          hrStream = streams.find(s => s.type === 'heartrate')?.data || [];
          altStream = streams.find(s => s.type === 'altitude')?.data || [];

          for (let j = 0; j < distStream.length; j += 3) {
            let pSecs = null;
            if (j >= 3 && timeStream.length > j) {
              const dDist = distStream[j] - distStream[j - 3];
              const dTime = timeStream[j] - timeStream[j - 3];
              if (dDist > 3 && dTime > 0) {
                const spk = dTime / (dDist / 1000);
                if (spk >= 120 && spk <= 800) {
                  pSecs = Math.round(spk);
                }
              }
            }

            trackpoints.push({
              dist: distStream[j] || 0,
              hr: hrStream[j] || 0,
              alt: altStream[j] || 0,
              pace: pSecs,
              time: timeStream[j] || 0
            });
          }
        }
      } catch (e) {
        console.warn(`Streams indisponíveis para atividade ${act.id}:`, e);
      }

      let laps = [];
      try {
        const actDetailRes = await fetch(`https://intervals.icu/api/v1/activity/${act.id}?intervals=true`, {
          headers: { Authorization: authHeader }
        });
        if (actDetailRes.ok) {
          const actDetail = await actDetailRes.json();
          // Prioriza as voltas oficiais do Garmin (intervals) sobre os blocos calculados (icu_intervals)
          const rawIntervals = (actDetail.intervals && actDetail.intervals.length > 1)
            ? actDetail.intervals
            : (actDetail.icu_intervals || []);

          // Descarta resíduos e micropassos espúrios (tempo <= 5s ou distância < 30m)
          const validIntervals = rawIntervals.filter(iv => {
            const secs = Math.round(iv.moving_time || iv.elapsed_time || 0);
            const dist = Math.round(iv.distance || 0);
            return secs > 5 && dist >= 30;
          });

          if (validIntervals.length > 1) {
            laps = validIntervals.map((iv, idx) => ({
              lap: idx + 1,
              seconds: Math.round(iv.moving_time || iv.elapsed_time || 0),
              meters: Math.round(iv.distance || 0),
              avgHr: Math.round(iv.average_heartrate || 0),
              maxHr: Math.round(iv.max_heartrate || 0)
            }));
          }
        }
      } catch (e) {
        console.warn('Erro ao consultar intervalos:', e);
      }

      if (laps.length <= 1 && distStream.length > 0) {
        const splits = [];
        let lapStartIndex = 0;
        let nextTargetDist = 1000;
        let lapNum = 1;

        for (let i = 0; i < distStream.length; i++) {
          const d = distStream[i];
          const isLast = (i === distStream.length - 1);

          if (d >= nextTargetDist || isLast) {
            const lapMeters = d - (lapStartIndex > 0 ? distStream[lapStartIndex] : 0);
            const tEnd = (timeStream.length > i) ? timeStream[i] : i;
            const tStart = (timeStream.length > lapStartIndex && lapStartIndex > 0) ? timeStream[lapStartIndex] : lapStartIndex;
            const lapSecs = tEnd - tStart;

            if (lapMeters >= 40 && lapSecs > 0) {
              let hrSum = 0;
              let hrCount = 0;
              let lapMaxHr = 0;

              for (let j = lapStartIndex; j <= i; j++) {
                const h = hrStream[j];
                if (h && h > 0) {
                  hrSum += h;
                  hrCount++;
                  if (h > lapMaxHr) lapMaxHr = h;
                }
              }

              splits.push({
                lap: lapNum++,
                seconds: Math.round(lapSecs),
                meters: Math.round(lapMeters),
                avgHr: hrCount > 0 ? Math.round(hrSum / hrCount) : 0,
                maxHr: lapMaxHr
              });
            }

            lapStartIndex = i;
            nextTargetDist += 1000;
          }
        }

        if (splits.length > 0) laps = splits;
      }

      const sport = (act.type || 'running').toLowerCase();
      const distanceMeters = act.distance || 0;
      const avgHr = Math.round(act.average_heartrate || 0);
      const durationSecs = act.moving_time || act.elapsed_time || 0;
      const durationMin = durationSecs / 60;

      let trimp = 0;

      if (avgHr > hrRest) {
        // Cálculo padrão de Banister com sensor cardíaco válido
        const hrRatio = (avgHr - hrRest) / (hrMax - hrRest);
        trimp = durationMin * hrRatio * 0.64 * Math.exp(1.92 * hrRatio);
      } else if (durationMin > 0) {
        // Equação de apoio (Fallback) quando o sensor cardíaco falha ou está ausente
        if (['running', 'run', 'walking'].includes(sport) && distanceMeters > 0 && durationSecs > 0) {
          const speedMs = distanceMeters / durationSecs;
          const estimatedRatio = Math.min(0.98, Math.max(0.40, speedMs * runEfficiencyFactor));
          trimp = durationMin * estimatedRatio * 0.64 * Math.exp(1.92 * estimatedRatio);
        } else {
          // Fallback por taxa média de TRIMP/minuto para ciclismo ou treinos indoor sem GPS
          const avgTpm = sportCounts[sport] ? (sportTrimpPerMin[sport] / sportCounts[sport]) : 1.2;
          trimp = durationMin * avgTpm;
        }
      }

      const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/workouts?on_conflict=start_time`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          start_time: startTime,
          sport: sport,
          distance_meters: distanceMeters,
          duration_seconds: durationSecs,
          avg_heart_rate: avgHr,
          max_heart_rate: Math.round(act.max_heart_rate || 0),
          trimp_score: trimp,
          laps: laps,
          trackpoints: trackpoints,
          is_deleted: false
        })
      });

      if (saveRes.ok) {
        if (existingWorkout) {
          updatedCount++;
        } else {
          syncedCount++;
        }
      }
    }

    return res.status(200).json({
      success: true,
      novosSincronizados: syncedCount,
      antigosAtualizadosComPace: updatedCount,
      totalAnalisados: activities.length
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}