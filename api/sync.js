// Limiar idêntico ao Strava para corrida: 1,5 km/h (~0,42 m/s)
// Preserva caminhadas leves de intervalo (3 a 5 km/h) e descarta apenas paradas reais e oscilação de GPS
const SPEED_THRESHOLD_MS = 0.42;

function calculateMovingStats(timeStream, distStream, hrStream) {
  if (!timeStream || !distStream || timeStream.length < 2) {
    return null;
  }

  let movingSecs = 0;
  let movingMeters = 0;
  let hrTimeSum = 0;
  let hrTimeTotal = 0;

  for (let i = 1; i < timeStream.length; i++) {
    const dt = timeStream[i] - timeStream[i - 1];
    const dd = distStream[i] - distStream[i - 1];

    if (dt > 0 && dt <= 30) {
      const speed = dd / dt;
      if (speed >= SPEED_THRESHOLD_MS) {
        movingSecs += dt;
        movingMeters += dd;
        const hr = hrStream[i] || hrStream[i - 1] || 0;
        if (hr > 0) {
          hrTimeSum += hr * dt;
          hrTimeTotal += dt;
        }
      }
    }
  }

  return {
    movingSecs: Math.round(movingSecs),
    movingMeters: Math.round(movingMeters),
    avgHr: hrTimeTotal > 0 ? Math.round(hrTimeSum / hrTimeTotal) : null
  };
}

export default async function handler(req, res) {
  const API_KEY = process.env.INTERVALS_API_KEY;
  const ATHLETE_ID = process.env.INTERVALS_ATHLETE_ID || 'i704231';
  const SUPABASE_URL = 'https://xttzilpuuqjbztjkeadd.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_uexabKupvCYRAAPqRiETSQ_I01UsSZI';

  const authHeader = 'Basic ' + Buffer.from('API_KEY:' + API_KEY).toString('base64');

  try {
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

    const supaCheck = await fetch(`${SUPABASE_URL}/rest/v1/workouts?select=id,start_time,laps,trackpoints`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
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

    let syncedCount = 0;
    let updatedCount = 0;

    for (const act of activities) {
      const startTime = act.start_date_local || act.start_date;
      const existingWorkout = existingMap.get(startTime);

      const hasLaps = existingWorkout && Array.isArray(existingWorkout.laps) && existingWorkout.laps.length > 0;
      const hasPaceInTrackpoints = existingWorkout && Array.isArray(existingWorkout.trackpoints) && existingWorkout.trackpoints.length > 0 && existingWorkout.trackpoints.some(tp => tp.pace !== null && tp.pace !== undefined);
      const hasBuggyLaps = existingWorkout && Array.isArray(existingWorkout.laps) && existingWorkout.laps.some(l => (l.seconds || 0) <= 5);

      if (hasLaps && hasPaceInTrackpoints && !hasBuggyLaps) {
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

      // Processamento de Moving Time e distância real via streams
      const movingStats = calculateMovingStats(timeStream, distStream, hrStream);

      const finalDuration = (movingStats && movingStats.movingSecs > 0)
        ? movingStats.movingSecs
        : (act.moving_time || act.elapsed_time || 0);

      const finalDistance = (movingStats && movingStats.movingMeters > 0)
        ? movingStats.movingMeters
        : (act.distance || 0);

      const avgHr = (movingStats && movingStats.avgHr)
        ? movingStats.avgHr
        : Math.round(act.average_heartrate || 0);

      let laps = [];
      try {
        const actDetailRes = await fetch(`https://intervals.icu/api/v1/activity/${act.id}?intervals=true`, {
          headers: { Authorization: authHeader }
        });
        if (actDetailRes.ok) {
          const actDetail = await actDetailRes.json();
          const rawIntervals = (actDetail.intervals && actDetail.intervals.length > 1)
            ? actDetail.intervals
            : (actDetail.icu_intervals || []);

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

      // Parciais de 1 km filtrando paradas na última volta
      if (laps.length <= 1 && distStream.length > 0) {
        const splits = [];
        let lapStartIndex = 0;
        let nextTargetDist = 1000;
        let lapNum = 1;

        for (let i = 0; i < distStream.length; i++) {
          const d = distStream[i];
          const isLast = (i === distStream.length - 1);

          if (d >= nextTargetDist || isLast) {
            const lapMetersRaw = d - (lapStartIndex > 0 ? distStream[lapStartIndex] : 0);

            // Calcula o tempo em movimento dentro do próprio intervalo da volta
            let lapMovingSecs = 0;
            let lapMovingMeters = 0;
            let hrSum = 0;
            let hrCount = 0;
            let lapMaxHr = 0;

            for (let j = lapStartIndex + 1; j <= i; j++) {
              const dt = (timeStream[j] || j) - (timeStream[j - 1] || (j - 1));
              const dd = (distStream[j] || 0) - (distStream[j - 1] || 0);
              const h = hrStream[j] || 0;

              if (dt > 0 && dt <= 30) {
                const spd = dd / dt;
                if (spd >= SPEED_THRESHOLD_MS) {
                  lapMovingSecs += dt;
                  lapMovingMeters += dd;
                  if (h > 0) {
                    hrSum += h * dt;
                    hrCount += dt;
                  }
                }
              }
              if (h > lapMaxHr) lapMaxHr = h;
            }

            const lapSecs = lapMovingSecs > 0
              ? lapMovingSecs
              : ((timeStream[i] || i) - (timeStream[lapStartIndex] || lapStartIndex));

            const lapMeters = lapMovingMeters > 0 ? lapMovingMeters : lapMetersRaw;

            if (lapMeters >= 40 && lapSecs > 0) {
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

      // TRIMP proporcional à duração real e FC ativa
      const durationMin = finalDuration / 60;
      const hrRatio = avgHr > hrRest ? (avgHr - hrRest) / (hrMax - hrRest) : 0;
      const trimp = durationMin * hrRatio * 0.64 * Math.exp(1.92 * hrRatio);

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
          sport: (act.type || 'running').toLowerCase(),
          distance_meters: Math.round(finalDistance),
          duration_seconds: finalDuration,
          avg_heart_rate: avgHr,
          max_heart_rate: Math.round(act.max_heartrate || 0),
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